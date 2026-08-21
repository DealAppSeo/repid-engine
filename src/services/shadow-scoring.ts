/**
 * shadow-scoring.ts — turn a settled interaction into a ledger row that MOVES
 * NOTHING.
 *
 * This is the wiring the E2E trust loop was missing: settled x402 payment →
 * `classifyOutcome` → a row in `repid_score_events`. In shadow mode the row is
 * recorded and the score is not touched, so the policy can be exercised against
 * real traffic and re-tuned against real history before a single agent's
 * reputation depends on it.
 *
 * PURE BY DESIGN. This module BUILDS the row; it does not insert it. Same reason
 * `x402-outcome-link.ts` refuses to resolve a tx hash: making the scoring path a
 * network call makes it untestable offline, and a scoring rule nobody can test
 * offline is a scoring rule nobody tests.
 *
 * ── FOUR THINGS THIS FILE EXISTS TO GET RIGHT ───────────────────────────────
 *
 * **1. `is_shadow` is a real column, never an overloaded one.** Two independent
 * plans green-lit "write `repid_delta_calculated` only, apply nothing" — and the
 * apply trigger reads `COALESCE(repid_delta_calculated, delta, 0)`, so
 * `repid_delta_calculated` is the APPLIED path and takes PRIORITY over `delta`.
 * Every "calculated-only" row would have been applied in full. Shadow mode would
 * have silently been enforce mode.
 *
 * **2. The ledger cannot hold the deltas the policy computes.** [MEASURED
 * 2026-08-21] `delta` and `repid_delta_calculated` are `integer`, while
 * `deltaFor` returns two decimal places. Postgres casts by rounding half AWAY
 * FROM ZERO — probed in a rolled-back transaction: `-24.75 → -25`, `-0.5 → -1`,
 * `0.4 → 0`, `0.5 → 1`, `2.4 → 2`.
 *
 * The tested invariants survive that (a confident fault is ~12x a success at
 * equal value, and rounding cannot invert a 12x gap), so this is not a scoring
 * bug. It is a REPLAY bug, and replay is the entire point of shadow rows: the
 * `FAILURE_COUNTERPARTY` "whisper of negative" is specified as `-0.5` and lands
 * as `-1`, doubled and unrecoverable, and every positive delta below 0.5
 * disappears. You cannot tune a weight whose whole effect is smaller than the
 * quantum your ledger can store.
 *
 * So the rounding is done HERE, explicitly, by the same rule Postgres would have
 * used — and the exact value is preserved losslessly alongside it as a
 * fixed-point integer, at the `DELTA_ENCODING_SCALE = 100` this codebase already
 * uses for exactly this problem. The number in `delta` is then one we chose, and
 * the number a re-tuning run reads is the one the policy actually computed.
 *
 * **3. `idempotency_key` must include the policy version.** The key is globally
 * unique (a partial unique index over non-null values). A key of "this
 * interaction" would therefore permit shadow-scoring an interaction EXACTLY
 * ONCE, ever — so the first re-tuning run against existing history would collide
 * on every row and the ability to re-score under a new policy, the reason shadow
 * mode exists, would be structurally impossible. The key is
 * `(mode, policy_version, interaction)`.
 *
 * Supplying a key at all is not optional on this path: an applied event with
 * neither a tx hash nor an idempotency key falls back to a placeholder
 * `payment_proof_hash`, which is UNIQUE and already taken, and the ENTIRE insert
 * fails. Shadow rows do not reach that write, but the same builder serves real
 * rows, so the key is always present.
 *
 * **4. All three parties are recorded from the first row.** v1 moves only the
 * provider's score. The consumer and the human builder are written anyway,
 * because provider-only history that omits them cannot be replayed once
 * three-party scoring lands, and history cannot be back-filled with facts nobody
 * stored.
 */
import { createHash } from 'crypto';
import {
  OutcomeClass,
  deltaFor,
  DELTA_ENCODING_SCALE,
  type OutcomeRecord,
  type DeltaResult,
} from './outcome-classification';
import { linkPaymentProof, type PaymentProof } from './x402-outcome-link';
import { assessRisk, type RiskAssessment } from './risk-tier';
import { currentPolicyVersion } from './policy-version';

/** Marks the shape of `metadata` so a later reader can tell which builder wrote a row. */
export const SHADOW_EVENT_SCHEMA = 'shadow-scoring.v1';

/** Namespace for keys this module mints. Distinct from `peer_verify:`, which has its own unique index. */
export const SHADOW_IDEMPOTENCY_PREFIX = 'shadow';
/** Namespace used when the same builder writes a row that IS applied. */
export const APPLIED_IDEMPOTENCY_PREFIX = 'outcome';

export interface SettledInteraction {
  /**
   * Stable, unique id for this interaction. The settlement tx hash or the
   * contract id — anything the caller can reproduce and will not reuse.
   * Re-scoring the SAME interaction under the SAME policy is what the
   * idempotency key is there to make a no-op.
   */
  interactionId: string;

  /** The agent that provided the service. The only score that moves in v1. */
  providerAgentId: string;
  /** The agent that bought the service. Recorded, not yet scored. */
  consumerAgentId?: string | null;
  /** The human who staked. Recorded, not yet scored. */
  builderId?: string | null;
  /** The service contract, when one exists. */
  contractId?: string | null;

  outcomeClass: OutcomeClass;
  /** Post-calibration confidence, 0–1. */
  halCalibratedConfidence: number;
  /** 0–100 from the ERC-8004 Validation Registry, when one was requested. */
  validationResponse?: number | null;

  /** Price of the service in USDC. */
  serviceValueUsdc: number;
  /** Stake exposed behind this interaction, in USDC. */
  stakeExposedUsdc: number;
  /**
   * Completed prior interactions between provider and consumer. `null` means
   * NOBODY LOOKED — see `risk-tier.ts`; it is priced conservatively and reported
   * as NOT_CHECKED, never as zero.
   */
  priorInteractions: number | null;

  paymentProof?: PaymentProof | null;
  /** Overrides the `repid_config` anchors when a caller has read them live. */
  riskThresholds?: { t1: number; t2: number };
  /** Chain the settlement is expected on. Defaults to `x402-outcome-link.ts`'s. */
  chainId?: number;
  /** Require the proof to have been OBSERVED on chain, not merely supplied. */
  requireVerifiedProof?: boolean;
}

/**
 * A row ready for a CALLER to write to the score-event table. This module never
 * writes it — see the purity note in the header.
 *
 * The wording matters, and not only for accuracy: `score-event-writer-ratchet`
 * detects raw writers by scanning source for the SQL, and its regex reads prose
 * as readily as code. An earlier draft of this comment spelled the statement out
 * and tripped the ratchet — which would have been "resolved" by adding this file
 * to the list of known raw writers, recording a debt that does not exist and
 * inflating the very count that guard reports. The ratchet is right to be
 * blunt about a money-adjacent table; a non-writer should simply not describe
 * itself as one.
 *
 * `repid_before` / `repid_after` are deliberately absent. They are `NOT NULL`,
 * and the shadow branch of `apply_repid_score_event` populates them BEFORE
 * INSERT from the agent's current score. Setting them here would be this
 * module's guess about a value the database already knows — and an early version
 * of that trigger returned before populating them, which would have failed every
 * shadow insert. That was caught by running it, not by reading it.
 */
export interface ShadowScoreEventRow {
  agent_id: string;
  event_type: string;
  /** The explicitly rounded delta. See note 2 in the header. */
  delta: number;
  repid_delta_calculated: number;
  is_shadow: boolean;
  policy_version: string;
  risk_tier: string;
  stake_at_event: number;
  economic_impact_usdc: number;
  builder_id: string | null;
  counterparty_agent_id: string | null;
  contract_id: string | null;
  certainty_at_claim: number;
  /** The authoritative outcome class. See `EVENT_TYPE_BY_OUTCOME`. */
  decision_outcome: string;
  idempotency_key: string;
  metadata: Record<string, unknown>;
}

export interface ShadowScoreResult {
  row: ShadowScoreEventRow;
  delta: DeltaResult;
  risk: RiskAssessment;
  /** True when a shape-valid payment proof survived and is anchoring this outcome. */
  anchored: boolean;
  /** Present when a supplied proof was rejected for shape, chain, or verification. */
  proofRejected?: { error: string; detail: string };
}

/**
 * Postgres rounds `numeric → integer` half AWAY FROM ZERO. JavaScript's
 * `Math.round` rounds half toward +∞, so `Math.round(-0.5)` is `-0` where
 * Postgres gives `-1`.
 *
 * Reproduced here so the value this module writes is the value it computed, and
 * so app and database never disagree about a number they both stored.
 */
export function roundHalfAwayFromZero(v: number): number {
  const r = Math.sign(v) * Math.round(Math.abs(v));
  // Normalise `-0` to `0`. Postgres has no signed zero, so returning one would
  // make the app and the database disagree about a value they both hold — and
  // `Object.is(-0, 0)` is false, so the disagreement would only ever surface in
  // a strict comparison somewhere far away. NaN is deliberately NOT normalised:
  // a non-finite delta is a bug upstream and must stay visible.
  return r === 0 ? 0 : r;
}

/**
 * Outcome class → an `event_type` the CHECK constraint accepts.
 *
 * **This mapping is lossy, and that is a finding, not a design.** The whitelist
 * is managed outside this repository and contains no value meaning "an outcome
 * was classified", so every class here is expressed by the least-wrong available
 * value. `decision_outcome` carries the exact class and is the authoritative
 * field; nothing should branch on `event_type` for attribution.
 *
 * The mapping never asserts something that did not happen — no failure is filed
 * as a delivery. `UNCERTAIN` gets the least assertive value available rather
 * than one claiming either delivery or failure. The correct fix is a whitelist
 * addition, which is an external schema change and belongs to whoever owns that
 * constraint.
 */
export const EVENT_TYPE_BY_OUTCOME: Readonly<Record<OutcomeClass, string>> = Object.freeze({
  [OutcomeClass.SUCCESS_AUDITED]: 'x402_value_delivered',
  [OutcomeClass.SUCCESS_UNAUDITED]: 'x402_value_delivered',
  [OutcomeClass.FAILURE_AGENT_FAULT]: 'VALIDATION_FAILED',
  [OutcomeClass.FAILURE_COUNTERPARTY]: 'VALIDATION_FAILED',
  [OutcomeClass.FAILURE_INFRA]: 'VALIDATION_FAILED',
  [OutcomeClass.REFUSED_CORRECTLY]: 'VALIDATION_PASSED',
  [OutcomeClass.UNCERTAIN]: 'HAL_SCORE_EVENT',
});

/**
 * `<mode>:<policy_version>:<digest of interaction id>`.
 *
 * The interaction id is DIGESTED rather than embedded. It is frequently a
 * settlement tx hash, and an idempotency key is not a place to mirror an
 * identifier that other systems key on — a 16-hex digest is unique enough to
 * collide never and opaque enough to be useless as a join key someone builds on
 * by accident.
 */
export function shadowIdempotencyKey(
  interactionId: string,
  policyVersion: string,
  mode: 'shadow' | 'applied' = 'shadow',
): string {
  const id = interactionId.trim();
  if (id.length === 0) {
    // Refuse rather than mint a key from an empty string: every such row would
    // share one key, the second insert would violate the unique index, and the
    // failure would surface far from its cause.
    throw new Error('interactionId is required to mint an idempotency key — an unkeyed event on this path fails its whole insert');
  }
  const prefix = mode === 'shadow' ? SHADOW_IDEMPOTENCY_PREFIX : APPLIED_IDEMPOTENCY_PREFIX;
  const digest = createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
  return `${prefix}:${policyVersion}:${digest}`;
}

/**
 * Score a settled interaction into a shadow ledger row.
 *
 * Pure: no clock, no I/O. Given the same interaction and the same policy it
 * returns the same row, which is what makes a replay a replay.
 */
export function buildShadowScoreEvent(
  interaction: SettledInteraction,
  opts: { policyVersion?: string; mode?: 'shadow' | 'applied' } = {},
): ShadowScoreResult {
  const policyVersion = opts.policyVersion ?? currentPolicyVersion();
  const mode = opts.mode ?? 'shadow';

  const risk = assessRisk({
    serviceValueUsdc: interaction.serviceValueUsdc,
    stakeExposedUsdc: interaction.stakeExposedUsdc,
    priorInteractions: interaction.priorInteractions,
    ...(interaction.riskThresholds ? { thresholds: interaction.riskThresholds } : {}),
  });

  const baseRecord: OutcomeRecord = {
    class: interaction.outcomeClass,
    x402PaymentProof: null,
    halCalibratedConfidence: interaction.halCalibratedConfidence,
    valueAtRisk: risk.valueAtRisk,
    validationResponse: interaction.validationResponse ?? null,
    timestamp: 0,
    agentId: interaction.providerAgentId,
    clientId: interaction.consumerAgentId ?? null,
  };

  const linked = linkPaymentProof(baseRecord, interaction.paymentProof, {
    ...(interaction.chainId !== undefined ? { chainId: interaction.chainId } : {}),
    ...(interaction.requireVerifiedProof !== undefined
      ? { requireVerified: interaction.requireVerifiedProof }
      : {}),
  });

  const delta = deltaFor(linked.record);

  // The exact value, losslessly, at the scale `deltaFor` already rounds to.
  const deltaExactFp = Math.round(delta.delta * DELTA_ENCODING_SCALE);
  const deltaRounded = roundHalfAwayFromZero(delta.delta);
  const roundingLossFp = deltaExactFp - deltaRounded * DELTA_ENCODING_SCALE;

  const row: ShadowScoreEventRow = {
    agent_id: interaction.providerAgentId,
    event_type: EVENT_TYPE_BY_OUTCOME[delta.effectiveClass],
    delta: deltaRounded,
    repid_delta_calculated: deltaRounded,
    is_shadow: mode === 'shadow',
    policy_version: policyVersion,
    risk_tier: risk.band,
    stake_at_event: interaction.stakeExposedUsdc,
    economic_impact_usdc: interaction.serviceValueUsdc,
    builder_id: interaction.builderId ?? null,
    counterparty_agent_id: interaction.consumerAgentId ?? null,
    contract_id: interaction.contractId ?? null,
    certainty_at_claim: Math.max(0, Math.min(1, interaction.halCalibratedConfidence)),
    decision_outcome: delta.effectiveClass,
    idempotency_key: shadowIdempotencyKey(interaction.interactionId, policyVersion, mode),
    metadata: {
      schema: SHADOW_EVENT_SCHEMA,
      outcome_class: delta.effectiveClass,
      claimed_outcome_class: interaction.outcomeClass,
      ...(delta.demotionReason ? { demotion_reason: delta.demotionReason } : {}),
      // Lossless. `delta` above is quantised by the integer column; this is not.
      delta_exact_fp100: deltaExactFp,
      delta_encoding_scale: DELTA_ENCODING_SCALE,
      // Non-zero whenever the ledger could not hold what the policy computed.
      // Recorded so the quantisation is visible in the data rather than inferred
      // from the schema by whoever tunes the weights next.
      delta_rounding_loss_fp100: roundingLossFp,
      risk: {
        band: risk.band,
        value_at_risk: risk.valueAtRisk,
        effective_value_at_risk: risk.effectiveValueAtRisk,
        novelty_multiplier: risk.noveltyMultiplier,
        novelty_evidence: risk.noveltyEvidence,
        thresholds: risk.thresholds,
      },
      payment: {
        anchored: linked.anchored,
        chain_id: interaction.paymentProof?.chainId ?? null,
        // The reference only — never an agent-asserted amount. A relying party
        // resolves the hash themselves; an amount we copied from the claimant is
        // just another unverified claim wearing evidence's clothes.
        tx_hash: linked.anchored ? (interaction.paymentProof?.txHash ?? null) : null,
        observed_on_chain: interaction.paymentProof?.verified === true,
        ...(linked.rejected ? { rejected: linked.rejected } : {}),
      },
      basis: delta.basis,
      parties: {
        provider_agent_id: interaction.providerAgentId,
        consumer_agent_id: interaction.consumerAgentId ?? null,
        builder_id: interaction.builderId ?? null,
        // v1 scores the provider only. Stated in the row so a later reader does
        // not have to infer from an absence which parties were in scope.
        scored: ['provider_agent_id'],
      },
    },
  };

  return {
    row,
    delta,
    risk,
    anchored: linked.anchored,
    ...(linked.rejected ? { proofRejected: linked.rejected } : {}),
  };
}
