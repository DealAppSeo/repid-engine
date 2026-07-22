import { db } from '../db';
import { getEcosystemNeedWeight, updateSupplyRate } from '../layers/ecosystem-need';
import { scoreChallengeOutcome } from '../layers/challenge-scoring';
import { scorePrediction } from '../layers/prediction-scoring';
import { applyDecay, computeRedemptionModifier } from '../layers/decay';
import { auditConstitutionalCompliance } from '../layers/constitutional-audit';
import { checkAndAwardBadges, BadgeAward } from './badges';
import { DETECTION_CONFIRM_THRESHOLD } from './behavioral-integrity';

export interface RepIdUpdateInput {
  agentId: string;
  eventType:
    | 'CHALLENGE_WIN'|'CHALLENGE_LOSS'|'CHALLENGE_DRAW'
    | 'EPISTEMIC_VIOLATION'|'CONSTITUTIONAL_VIOLATION'
    | 'PREDICTION_RESOLVE'
    | 'STAKE'|'GENESIS'|'REFERRAL'|'PEACEMAKER'|'SELF_MONITOR'
    | 'CODE_CONTRIBUTION' | 'WORKFLOW_CONTRIBUTION' | 'TOOL_PIONEER'
    | 'AGENT_TEACHING' | 'AUDIT_CONTRIBUTION'
    | 'HANDOFF_COSIGN_VERIFIED' | 'HANDOFF_COSIGN_FALSE_PASS_SLASH'
    | 'PEER_VERIFY_WRONG_CALL' // Phase 3 dogfooding (behind DOGFOOD_REPID_FROM_COSIGN) + BFT panel divergence
    // --- Ordinary error (light penalty) ------------------------------------
    // An honest wrong answer / unsupported claim. Penalized, but LIGHTLY — it
    // does not attack supervisability. Contrast with DEFENDED_DECEPTION_* below.
    | 'UNSUPPORTED_CLAIM'
    // --- Defended deception (heavy penalty) — Trust Harness P1 KEYSTONE M1 ---
    // These attack the ability to supervise the agent (they corrupt the record
    // itself), so they carry a markedly heavier negative delta than ordinary
    // error. ENFORCEMENT is shadow-first behind TRUST_DECEPTION_MODE (below).
    | 'DEFENDED_DECEPTION_DENIAL_OF_PRIOR_OUTPUT'
    | 'DEFENDED_DECEPTION_DOUBT_ATTACK'
    | 'DEFENDED_DECEPTION_FABRICATED_CITATION'
    | 'DEFENDED_DECEPTION_FABRICATED_TOOL_RESULT'
    | 'DEFENDED_DECEPTION_FABRICATED_BENCHMARK'
    | 'DEFENDED_DECEPTION_THRESHOLD_DANCING'
    | 'DEFENDED_DECEPTION_SYCOPHANTIC_FALSE_PREMISE'
    | 'DEFENDED_DECEPTION_STORY_CHANGE';
  certaintyAtClaim?: number;
  pStated?: number;
  pCorrect?: number;
  predictionDaysAgo?: number;
  networkImportance?: number;
  isPeacemaker?: boolean;
  selfMonitoring?: boolean;
  constitutionalAdherence?: boolean;
  mirrorTestTriggered?: boolean;
  mirrorTestMetadata?: {
    originalFraming: string;
    invertedFraming: string;
    autoMode: 7;
  };
  x402Context?: {
    paymentAmount: number;
    paymentCurrency: string;
    x402RequestId: string;
  };
  // Provenance for a VERIFIED on-chain stake. The STAKE delta (+5) only
  // applies when this is present — a STAKE event without a verified on-chain
  // stake yields delta 0 (honest: no verified stake, no +5). Populated by the
  // /stake/onchain/verify route after verifyStakeOnChain() confirms the
  // RepIDStaking `Staked` event on Base Sepolia.
  stakeProof?: {
    txHash: string;
    stakeId?: string;
    amountWei?: string;
    contractAddress?: string;
    onChainAgentId?: string;
    blockNumber?: number;
  };
  // Provenance for a DEFENDED_DECEPTION_* event: the M2 behavioral-integrity
  // detection (class/confidence/evidence + receipt refs) that produced this
  // penalty. Recorded in the audit row so a shadow-mode measurement is fully
  // replayable. Populated by the detector -> penalty bridge (see M2 module).
  deceptionProof?: {
    class: string;
    confidence: number;
    grounded: boolean;
    evidence: string;
    receiptRefs: string[];
  };
}

export interface RepIdUpdateResult {
  agentId: string;
  agentName: string;
  repIdBefore: number;
  repIdAfter: number;
  delta: number;
  tier: string;
  ecosystemNeedWeight: number;
  redemptionModifierApplied: boolean;
  constitutionalAudit: {
    // enabled=false → the audit is a non-load-bearing stub; passed/complianceScore
    // are placeholders, not measurements (RULE-4). Callers must not treat them as real.
    enabled: boolean;
    passed: boolean | null;
    complianceScore: number | null;
    halMode: number;
    easAttestationId: string;
    easSchema: string;
    processingMs: number;
  };
  newBadges?: BadgeAward[];
}

export function computeTier(repId: number): string {
  if (repId >= 8000) return 'VETERAN';
  if (repId >= 5000) return 'AUTONOMOUS';
  if (repId >= 1000) return 'ESTABLISHED';
  if (repId >= 500) return 'EARNING';
  return 'PROBATIONARY';
}

const FIXED_DELTAS: Partial<Record<RepIdUpdateInput['eventType'], number>> = {
  STAKE: 5, GENESIS: 0, REFERRAL: 20, PEACEMAKER: 15, SELF_MONITOR: 10,
  CODE_CONTRIBUTION: 25, WORKFLOW_CONTRIBUTION: 20, TOOL_PIONEER: 12,
  AGENT_TEACHING: 15, AUDIT_CONTRIBUTION: 15,
  HANDOFF_COSIGN_VERIFIED: 10, // producer + verifier each get + on verified co-sign (calibrated)
  HANDOFF_COSIGN_FALSE_PASS_SLASH: -15, // slash the rubber-stamper (verifier) on false-PASS
  PEER_VERIFY_WRONG_CALL: -5, // BFT panel: reviewer diverged from majority (bounded; low-confidence self-flag exempt)
  // Ordinary error — an honest wrong/unsupported claim. LIGHT penalty. This is
  // the baseline the deception tiers below are deliberately heavier than.
  UNSUPPORTED_CLAIM: -8,
};

// --- DECEPTION_DELTAS — Trust Harness P1 KEYSTONE (M1) --------------------
// Defended deception attacks SUPERVISABILITY (it corrupts the record the whole
// trust system depends on), so every class here is markedly heavier than the
// ordinary-error baseline (UNSUPPORTED_CLAIM = -8). Two tiers within deception:
//
//   RECORD-CORRUPTING  (-60): the agent falsified the record itself — denied a
//     receipted output, fabricated a tool result / citation / benchmark, or
//     changed its story across turns. These are provable against the M2 chain
//     and are the core of Sean's scar: an actor you cannot supervise.
//   SUPERVISION-EVASION (-40): doubt-attack / sycophantic-false-premise /
//     threshold-dancing — attacks on the supervisor's judgment rather than the
//     record. Heavy, but the M2 detectors for these are heuristic (lower
//     confidence), so the tier is one step below record-corrupting.
//
// These are ~5-8x the ordinary-error penalty by design. The asymmetry IS the
// mechanism: honest error stays cheap so agents surface it; defended deception
// is expensive so it is never the profitable move.
const DECEPTION_DELTAS: Partial<Record<RepIdUpdateInput['eventType'], number>> = {
  DEFENDED_DECEPTION_DENIAL_OF_PRIOR_OUTPUT: -60,
  DEFENDED_DECEPTION_FABRICATED_CITATION: -60,
  DEFENDED_DECEPTION_FABRICATED_TOOL_RESULT: -60,
  DEFENDED_DECEPTION_FABRICATED_BENCHMARK: -60,
  DEFENDED_DECEPTION_STORY_CHANGE: -60,
  DEFENDED_DECEPTION_DOUBT_ATTACK: -40,
  DEFENDED_DECEPTION_SYCOPHANTIC_FALSE_PREMISE: -40,
  DEFENDED_DECEPTION_THRESHOLD_DANCING: -40,
};

/** True for the 8 defended-deception event classes (M1). */
export function isDeceptionEvent(eventType: RepIdUpdateInput['eventType']): boolean {
  return eventType in DECEPTION_DELTAS;
}

/** The record-corrupting classes eligible for the heavy (-60) tier. */
const RECORD_CORRUPTING_EVENTS = new Set<RepIdUpdateInput['eventType']>([
  'DEFENDED_DECEPTION_DENIAL_OF_PRIOR_OUTPUT',
  'DEFENDED_DECEPTION_FABRICATED_CITATION',
  'DEFENDED_DECEPTION_FABRICATED_TOOL_RESULT',
  'DEFENDED_DECEPTION_FABRICATED_BENCHMARK',
  'DEFENDED_DECEPTION_STORY_CHANGE',
]);

/**
 * The advisory delta a deception event collapses to when it is NOT backed by a
 * confirmed detection. This is ZERO — LOG-ONLY, no penalty (M1 finding 3).
 *
 * An unconfirmed / heuristic / below-threshold deception signal must never dock
 * an honest agent: for a TRUST product a false penalty on honest behavior is the
 * worst outcome, and the ordinary-error weight (-8) is itself a real penalty, so
 * collapsing to -8 still eroded reputation on a heuristic false-positive during
 * honest debate. We therefore record the unconfirmed signal in the audit row as
 * advisory but apply delta 0. A negative delta is reserved for CONFIRMED grounded
 * detections (the -60 / -40 tiers) — never for a heuristic hunch.
 */
const DECEPTION_ADVISORY_DELTA = 0;

/**
 * Gate a defended-deception penalty on a CONFIRMED detection (M1 findings 4+5).
 * Returns the delta the event is ALLOWED to carry:
 *   - The heavy delta ONLY when a deceptionProof is present AND confidence >= the
 *     confirm threshold. The -60 record-corrupting tier ADDITIONALLY requires
 *     grounded === true (no -60 on heuristics); the -40 supervision-evasion tier
 *     does NOT require grounded (its detectors are heuristic by design — a
 *     confirmed heuristic at confidence >= threshold is enough for -40).
 *   - Otherwise delta 0 (log-only advisory) — an unproven / heuristic /
 *     below-threshold detection can NEVER reach the heavy tier and, for a trust
 *     product, an UNCONFIRMED signal must NOT dock an honest agent at all: we
 *     record it in the audit row as advisory but apply zero penalty. A negative
 *     delta is reserved for CONFIRMED detections only.
 *
 * A missing proof is treated as UNCONFIRMED on purpose: the penalty bridge must
 * supply the M2 detection that justifies the heavy delta; without it we do not
 * assume guilt.
 */
export function gatedDeceptionDelta(input: RepIdUpdateInput): {
  delta: number;
  confirmed: boolean;
  reason: string;
} {
  const heavy = DECEPTION_DELTAS[input.eventType] ?? 0;
  const proof = input.deceptionProof;

  if (!proof) {
    return {
      delta: DECEPTION_ADVISORY_DELTA,
      confirmed: false,
      reason: 'no deceptionProof supplied — advisory log-only, delta 0 (unconfirmed)',
    };
  }
  if (proof.confidence < DETECTION_CONFIRM_THRESHOLD) {
    return {
      delta: DECEPTION_ADVISORY_DELTA,
      confirmed: false,
      reason: `below confirm threshold (${proof.confidence} < ${DETECTION_CONFIRM_THRESHOLD}) — advisory log-only, delta 0`,
    };
  }
  // A -60 record-corrupting penalty additionally REQUIRES a grounded proof.
  if (RECORD_CORRUPTING_EVENTS.has(input.eventType) && !proof.grounded) {
    return {
      delta: DECEPTION_ADVISORY_DELTA,
      confirmed: false,
      reason: 'record-corrupting class without a grounded proof — advisory log-only, delta 0 (no -60 on heuristics)',
    };
  }
  return { delta: heavy, confirmed: true, reason: 'confirmed grounded detection' };
}

/**
 * TRUST_DECEPTION_MODE gate (M1). SHADOW-FIRST by default: in `shadow` mode we
 * COMPUTE the (heavy) deception delta and write a replayable audit row tagged
 * mode='shadow-deception' with the would-be delta, but do NOT mutate
 * current_repid. In `enforce` mode the delta is applied. Any value other than
 * the explicit 'enforce' resolves to shadow — enforcement is never incidental.
 */
export function deceptionMode(): 'shadow' | 'enforce' {
  return (process.env.TRUST_DECEPTION_MODE || '').toLowerCase() === 'enforce'
    ? 'enforce'
    : 'shadow';
}

export async function updateRepId(input: RepIdUpdateInput): Promise<RepIdUpdateResult> {
  // Phase 3 dogfooding gate: co-sign -> RepID only if flag ON (default OFF until CC honest-HAL merge)
  const isDogfoodCoSignEvent = input.eventType === 'HANDOFF_COSIGN_VERIFIED' || input.eventType === 'HANDOFF_COSIGN_FALSE_PASS_SLASH';
  if (isDogfoodCoSignEvent && process.env.DOGFOOD_REPID_FROM_COSIGN !== 'true') {
    // flag-OFF no-op: return a no-delta result (tests cover this)
    const { data: agent } = await db.from('repid_agents').select('*').eq('id', input.agentId).single();
    return {
      agentId: input.agentId,
      agentName: agent?.agent_name || 'unknown',
      repIdBefore: agent?.current_repid || 0,
      repIdAfter: agent?.current_repid || 0,
      delta: 0,
      tier: computeTier(agent?.current_repid || 0),
      ecosystemNeedWeight: 0,
      redemptionModifierApplied: false,
      constitutionalAudit: { enabled: false, passed: null, complianceScore: null, halMode: 0, easAttestationId: '', easSchema: '', processingMs: 0 },
    } as any;
  }

  // 1 — Fetch agent
  const { data: agent, error } = await db
    .from('repid_agents').select('*').eq('id', input.agentId).single();
  if (error || !agent)
    throw new Error(`[repid-engine] Agent not found: ${input.agentId}`);

  // 2 — Constitutional audit (pre-execution injection hook)
  // NON-LOAD-BEARING (RULE-4, 2026-07-05): this is a Sprint-3 stub — LASSO/ANFIS/
  // mirror are not real (anfis_scoreCompliance returns a hardcoded 1.0). It is
  // gated behind CONSTITUTIONAL_AUDIT_ENABLED (default OFF). Its output does NOT
  // steer the RepID delta here; when disabled (`audit.enabled === false`) it is
  // recorded honestly in the audit row as "not measured", never as a real score.
  // EAS attestation via ERC-8004 ValidationRegistry is a stub UID.
  const audit = await auditConstitutionalCompliance({
    agentId: input.agentId,
    actionType: input.eventType,
    actionMetadata: {
      certaintyAtClaim: input.certaintyAtClaim,
      x402Context: input.x402Context,
    },
  });

  // 3 — Decay
  const decayedRepId = applyDecay(agent.current_repid, agent.activity_30d);

  // 4 — Ecosystem need weight
  const ecosystemNeedWeight = await getEcosystemNeedWeight(input.eventType);

  // 5 — Delta by event type
  let rawDelta: number;
  const challengeTypes = new Set([
    'CHALLENGE_WIN','CHALLENGE_LOSS','CHALLENGE_DRAW',
    'EPISTEMIC_VIOLATION','CONSTITUTIONAL_VIOLATION'
  ]);
  if (challengeTypes.has(input.eventType)) {
    const outcomeMap: Record<string, any> = {
      CHALLENGE_WIN:'WIN', CHALLENGE_LOSS:'LOSS', CHALLENGE_DRAW:'DRAW',
      EPISTEMIC_VIOLATION:'EPISTEMIC_VIOLATION',
      CONSTITUTIONAL_VIOLATION:'CONSTITUTIONAL_VIOLATION',
    };
    rawDelta = scoreChallengeOutcome({
      outcome: outcomeMap[input.eventType],
      certaintyAtClaim: input.certaintyAtClaim ?? 0.5,
      ecosystemNeedWeight,
      isPeacemaker: input.isPeacemaker,
      selfMonitoring: input.selfMonitoring,
      constitutionalAdherence: input.constitutionalAdherence,
    });
  } else if (input.eventType === 'PREDICTION_RESOLVE') {
    rawDelta = Math.round(scorePrediction({
      pStated: input.pStated ?? 0.5,
      pCorrect: input.pCorrect ?? 0,
      daysAgo: input.predictionDaysAgo ?? 0,
      networkImportance: input.networkImportance ?? 1.0,
    }));
  } else if (input.eventType === 'STAKE') {
    // STOPGAP (2026-07-21): a client-supplied stakeProof is UNVERIFIED → delta 0.
    // The prior comment claimed a `/stake/onchain/verify` route confirmed a
    // `Staked` event before awarding +5. That route DOES NOT EXIST anywhere in
    // this repo (grep: only these comments), so the old truthiness gate
    // (`stakeProof?.txHash ? +5 : 0`) awarded +5 for ANY caller-supplied string
    // on the auth-gated /score path — repeatable to inflate RepID. Until a real
    // server-side verifier lands (fetch the Base-Sepolia receipt, confirm the
    // RepIDStaking `Staked` event, bind it to agentId, and guard txHash replay),
    // STAKE earns nothing here — no fake-verified scoring (RULE-4). The client
    // `stakeProof` is retained on the input only for that future verify route.
    // TODO(STAKE-VERIFY, Sean-gated: on-chain): implement verifyStakeOnChain().
    rawDelta = 0;
  } else if (isDeceptionEvent(input.eventType)) {
    // DEFENDED DECEPTION (M1). The negative delta is GATED on a confirmed,
    // grounded M2 detection (findings 4+5): the heavy -60/-40 tier applies only
    // when input.deceptionProof is present, confirmed (and grounded for -60). An
    // unproven / heuristic / below-threshold detection collapses to delta 0
    // (log-only advisory — never penalize an honest agent on an unconfirmed
    // signal), never the heavy tier, and never -60 without a grounded proof.
    // This is COMPUTED here regardless of TRUST_DECEPTION_MODE;
    // whether it MUTATES the score is decided below by the shadow/enforce gate.
    rawDelta = gatedDeceptionDelta(input).delta;
  } else {
    rawDelta = FIXED_DELTAS[input.eventType] ?? 0;
  }

  // 6 — Redemption modifier (Micah 6:8 as math)
  const redemptionMod = await computeRedemptionModifier(input.agentId);
  const redemptionApplied = redemptionMod < 1.0 && rawDelta < 0;
  const computedDelta = redemptionApplied ? Math.round(rawDelta * redemptionMod) : rawDelta;

  // 6b — SHADOW-FIRST gate (M1). For a deception event in shadow mode, the
  // COMPUTED (would-be) delta is recorded in the audit row, but the APPLIED
  // delta is 0 — current_repid is never mutated. Enforce mode applies it.
  // Non-deception events are unaffected (applied === computed). Never silently
  // mutate: the mode label is written into the audit row below.
  const isDeception = isDeceptionEvent(input.eventType);
  const decMode = deceptionMode();
  // SHADOW-DECEPTION must be TRULY INERT (finding 2): a shadow deception event
  // may not move current_repid AT ALL — not via the delta AND not via decay —
  // and may not increment activity_30d. We therefore short-circuit both the
  // applied delta AND the decay on this path, leaving current_repid exactly as
  // it was. The audit row then honestly reflects no move: delta 0 AND
  // repid_after === repid_before, mode 'shadow-deception'. (Enforce mode and all
  // non-deception events keep the normal decay + delta behavior.)
  const isShadowDeception = isDeception && decMode === 'shadow';
  const finalDelta = isShadowDeception ? 0 : computedDelta;

  // 7 — New RepID and tier (uses the APPLIED delta; shadow deception => no move).
  // On the shadow-deception path the score is left UNCHANGED (no decay applied),
  // so repid_after === repid_before and the event is a pure measurement.
  const newRepId = isShadowDeception
    ? agent.current_repid
    : Math.max(10, Math.min(10000, decayedRepId + finalDelta));
  const newTier = computeTier(newRepId);

  // 8 — AUDIT ROW FIRST (atomicity reorder, 2026-06-29). Write the replayable ledger row BEFORE
  // mutating the score, so a failed insert can NEVER leave current_repid changed without an audit
  // row (the drift proven live: a constraint-failed insert had mutated the score first). If the
  // insert throws, the score is never touched. (True txn atomicity via an RPC is the follow-up; this
  // reorder eliminates the common drift case.)
  //
  // eas_attestation_id links every event to an EAS attestation via ERC-8004 ValidationRegistry.
  // mirror_test_triggered = ZKP-auditable proof of ideological neutrality (P-023/P-024).
  // HONEST-HAL: record mode in metadata.mode (prod has no top-level `mode` column).
  // Mode label must mirror the ACTUAL behavioral gate (src/scoring/pipeline.ts): the gate uses the
  // SINGULAR var, default-ON (`!== 'false'`). Using the plural default-off spelling here mislabelled
  // the recorded mode. Metadata-accuracy fix only — the gate logic is untouched.
  // For a deception event the recorded mode is the deception gate's mode:
  //   'shadow-deception' = delta COMPUTED + recorded, NOT applied (default)
  //   'enforce-deception' = delta applied to current_repid
  // For all other events the mode continues to mirror the HAL gate as before.
  const halMode = isDeception
    ? (decMode === 'enforce' ? 'enforce-deception' : 'shadow-deception')
    : process.env.DOGFOOD_REPID_FROM_COSIGN === 'true' ? 'shadow' : process.env.HAL_DECISION_REQUIRES_QUORUM !== 'false' ? 'live' : 'off';

  const { error: auditError } = await db.from('repid_score_events').insert({
    agent_id: input.agentId,
    event_type: input.eventType,
    delta: finalDelta,
    repid_before: agent.current_repid,
    repid_after: newRepId,
    certainty_at_claim: input.certaintyAtClaim ?? null,
    hal_score: 0.0, // (S-HONEST-HAL Phase 2: wire HAL fact-check verdicts here)
    hal_decision: 'clean', // (S-HONEST-HAL Phase 2: map HAL veto/flag/clean)
    ecosystem_need_weight: ecosystemNeedWeight,
    mirror_test_triggered: input.mirrorTestTriggered ?? !audit.mirrorTestPassed,
    eas_attestation_id: audit.easAttestationId,
    // (S-HONEST-HAL) record mode kept in metadata.mode — prod repid_score_events has NO top-level
    // `mode` column; a top-level write here silently failed the whole audit insert (see throw below).
    metadata: {
      mode: halMode, // 'shadow' = test mode, 'live' = of-record, 'off' = HAL not wired;
                     // 'shadow-deception'/'enforce-deception' for M1 defended-deception events
      // M1 shadow-first: the would-be penalty. In shadow-deception mode the
      // top-level `delta` above is 0 (score untouched) but deltaComputed is the
      // heavy delta that WOULD apply under enforce mode — this is the measurement.
      deltaComputed: computedDelta,
      // Provenance for a defended-deception penalty: the M2 detection that
      // triggered it (class/confidence/evidence + receipt refs). Null otherwise.
      deceptionProof: isDeception ? (input.deceptionProof ?? null) : null,
      // M1 findings 4+5: whether the deception delta was backed by a CONFIRMED,
      // grounded detection. When false, the event was routed to the light
      // advisory delta (never the heavy -60/-40 tier) — recorded so a shadow
      // measurement can distinguish real grounded hits from advisory ones.
      deceptionConfirmed: isDeception ? gatedDeceptionDelta(input).confirmed : null,
      deceptionGateReason: isDeception ? gatedDeceptionDelta(input).reason : null,
      // Shadow-deception is inert: NO decay is applied on that path, so record 0.
      decayApplied: isShadowDeception ? 0 : agent.current_repid - decayedRepId,
      redemptionModifier: redemptionMod,
      redemptionModifierApplied: redemptionApplied,
      constitutionalAudit: {
        // RULE-4: when the audit is a disabled stub, record it as not-measured —
        // never persist the placeholder pass/1.0 as if it were a real audit result.
        enabled: audit.enabled,
        passed: audit.enabled ? audit.passed : null,
        complianceScore: audit.enabled ? audit.complianceScore : null,
        rulesChecked: audit.enabled ? audit.rulesChecked : [],
        halMode: audit.halMode,
        easSchema: audit.easSchema,
        processingMs: audit.processingMs,
      },
      mirrorTest: input.mirrorTestMetadata ?? null,
      x402Context: input.x402Context ?? null,
      // Provenance for a proof-gated STAKE delta: the verified on-chain stake
      // that backs this +5. Null for every non-STAKE event and for any STAKE
      // event that arrived without proof (delta 0).
      stakeProof: input.eventType === 'STAKE' ? (input.stakeProof ?? null) : null,
    },
  });

  // RULE-11 / fail-loud (S-HONEST-HAL integrity): a money/reputation surface must NEVER mutate
  // current_repid without first writing its repid_score_events audit row. This throw runs BEFORE the
  // score update below, so a failed audit insert (e.g. a constraint violation) can never leave the
  // score changed without a row — the irreconcilable-ledger drift, proven live 2026-06-29 and now
  // eliminated by ordering insert→update.
  if (auditError) {
    throw new Error(
      `[repid-engine] repid_score_events audit insert FAILED for agent ${input.agentId} ` +
      `(event=${input.eventType}, delta=${finalDelta}): ${auditError.message}`,
    );
  }

  // 9 — Apply the score AFTER the audit row is safely written (atomicity reorder 2026-06-29, gated
  // by WRITER_DIRECT_APPLY for single-applier cutover). The ledger row already exists, so even if
  // this update fails the state stays reconcilable via replay — never a silent score-without-row drift.
  //
  // SHADOW-DECEPTION INERTNESS (finding 2): on the shadow-deception path we skip
  // the repid_agents write ENTIRELY. Writing it would (a) re-persist current_repid
  // (still risky if decay were ever reintroduced) and (b) increment activity_30d
  // — a side effect that is NOT inert. A shadow measurement must leave both
  // current_repid AND activity_30d untouched, so we do not write at all.
  const WRITER_DIRECT_APPLY = process.env.WRITER_DIRECT_APPLY !== 'false';
  if (WRITER_DIRECT_APPLY && !isShadowDeception) {
    await db.from('repid_agents').update({
      current_repid: newRepId, tier: newTier,
      last_updated: new Date().toISOString(),
      activity_30d: agent.activity_30d + 1,
    }).eq('id', input.agentId);
  }

  // 10 — Update supply rate. SHADOW-DECEPTION INERTNESS (finding 1): a shadow
  // deception measurement must produce ZERO operational DB side-effects beyond
  // the single audit row. updateSupplyRate() mutates repid_ecosystem_supply
  // counters — an operational side-effect — so it is skipped on the shadow path.
  if (!isShadowDeception) {
    await updateSupplyRate(input.eventType);
  }

  // 11 — Badge milestone check (non-blocking — never fails score flow).
  // SHADOW-DECEPTION INERTNESS (finding 1): checkAndAwardBadges() can WRITE to
  // repid_badges (another operational side-effect), so it is skipped on the
  // shadow path too. A shadow event leaves badges untouched.
  let newBadges: BadgeAward[] = [];
  if (!isShadowDeception) {
    try {
      newBadges = await checkAndAwardBadges(input.agentId, agent.current_repid, newRepId);
    } catch {
      newBadges = [];
    }
  }

  return {
    agentId: input.agentId, agentName: agent.agent_name,
    repIdBefore: agent.current_repid, repIdAfter: newRepId,
    delta: finalDelta, tier: newTier, ecosystemNeedWeight,
    redemptionModifierApplied: redemptionApplied,
    constitutionalAudit: {
      enabled: audit.enabled,
      passed: audit.enabled ? audit.passed : null,
      complianceScore: audit.enabled ? audit.complianceScore : null,
      halMode: audit.halMode,
      easAttestationId: audit.easAttestationId,
      easSchema: audit.easSchema,
      processingMs: audit.processingMs,
    },
    newBadges,
  };
}

export async function registerAgent(params: {
  erc8004Address: string;
  agentName: string;
  conservatorAddress?: string;
  constitution?: Record<string, unknown>;
}): Promise<{ agentId: string; repId: number; tier: string }> {
  const { data: existing } = await db.from('repid_agents')
    .select('id').eq('erc8004_address', params.erc8004Address).single();
  if (existing)
    throw new Error(`[repid-engine] Already registered: ${params.erc8004Address}`);

  const { data: newAgent, error } = await db.from('repid_agents').insert({
    erc8004_address: params.erc8004Address,
    agent_name: params.agentName,
    conservator_address: params.conservatorAddress ?? null,
    constitution: params.constitution ?? {},
    current_repid: 200, tier: 'PROBATIONARY',
  }).select('id').single();

  if (error || !newAgent)
    throw new Error(`[repid-engine] Registration failed: ${error?.message}`);

  await db.from('repid_score_events').insert({
    agent_id: newAgent.id, event_type: 'GENESIS',
    delta: 0, repid_before: 200, repid_after: 200,
    ecosystem_need_weight: 1.0,
    eas_attestation_id: `eas-stub-genesis-${newAgent.id.slice(0,8)}`,
    metadata: {
      erc8004_address: params.erc8004Address,
      conservator: params.conservatorAddress ?? null,
      constitutionLoaded: Object.keys(params.constitution ?? {}).length > 0,
      easSchema: 'constitutional-compliance-v1',
    },
  });

  return { agentId: newAgent.id, repId: 200, tier: 'PROBATIONARY' };
}
