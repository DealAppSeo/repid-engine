/**
 * outcome-classification.ts — turn a real interaction into the number the
 * progressive fold consumes.
 *
 * THE MECHANISM THIS MAKES REAL. "Confident hallucination is expensive" has been
 * a design principle with nothing enforcing it. Here it is arithmetic: the
 * penalty for FAILURE_AGENT_FAULT scales with the confidence the agent asserted,
 * so being confidently wrong costs strictly more than being wrong while hedging,
 * and both cost more than an honest refusal earns.
 *
 * THE INVARIANT THAT MUST HOLD (tested):
 *
 *     delta(REFUSED_CORRECTLY)  >  delta(FAILURE_AGENT_FAULT at any confidence)
 *     |delta(FAILURE_AGENT_FAULT @ high conf)| > delta(SUCCESS_AUDITED @ same value)
 *
 * The second is the load-bearing one. If a confident error cost less than a
 * success earned, the rational strategy would be to guess confidently and often
 * — which is precisely the behaviour the whole harness exists to price out.
 * Positive movement is deliberately slower than negative: reputation should be
 * earned gradually and lost quickly.
 *
 * PAYMENT PROOF AS ANCHOR. Above `PAYMENT_PROOF_REQUIRED_ABOVE`, a claimed
 * success with no linked x402 settlement is DEMOTED to SUCCESS_UNAUDITED rather
 * than trusted. Unanchored self-reported success is the cheapest thing in the
 * world to manufacture; wash-trading reputation should require actually moving
 * money.
 */

export enum OutcomeClass {
  /** Delivered, passed HAL, and (optionally) a Validation Registry response. */
  SUCCESS_AUDITED = 'SUCCESS_AUDITED',
  /** Delivered, but with light or no audit. */
  SUCCESS_UNAUDITED = 'SUCCESS_UNAUDITED',
  /** Confident hallucination, fabricated data, broken commitment. The agent's fault. */
  FAILURE_AGENT_FAULT = 'FAILURE_AGENT_FAULT',
  /** Client-side or payment failure. Not the agent's fault. */
  FAILURE_COUNTERPARTY = 'FAILURE_COUNTERPARTY',
  /** Timeout, rate limit, network. Nobody's fault. */
  FAILURE_INFRA = 'FAILURE_INFRA',
  /** The gate correctly refused. A POSITIVE signal — restraint is work. */
  REFUSED_CORRECTLY = 'REFUSED_CORRECTLY',
  /** Not enough signal to classify. Earns and costs nothing. */
  UNCERTAIN = 'UNCERTAIN',
}

export interface OutcomeRecord {
  class: OutcomeClass;
  /** x402 settlement tx hash (or equivalent). The anchor that makes success expensive to fake. */
  x402PaymentProof?: string | null;
  /** Post-calibration confidence, 0–1. See hal-calibration.ts. */
  halCalibratedConfidence: number;
  /** Raw signals, carried for audit. Never used for the delta — only the calibrated value is. */
  halRawSignals?: Record<string, number>;
  /** Economic value of the job, in whatever unit the caller uses consistently. */
  valueAtRisk: number;
  /** 0–100 from the ERC-8004 Validation Registry, when one was requested. */
  validationResponse?: number | null;
  timestamp: number;
  agentId: string;
  clientId?: string | null;
}

/** Above this value, a success claim needs a payment proof or it is demoted. */
export const PAYMENT_PROOF_REQUIRED_ABOVE = 10;

/** Ceiling on a single positive delta. Reputation is earned gradually. */
export const MAX_POSITIVE_DELTA = 25;
/** Ceiling on a single negative delta. Deliberately larger than the positive one. */
export const MAX_NEGATIVE_DELTA = -120;

export interface DeltaResult {
  delta: number;
  /** The class actually applied — may differ from the claim if it was demoted. */
  effectiveClass: OutcomeClass;
  /** Why, in one line. Present whenever effectiveClass !== record.class. */
  demotionReason?: string;
  /** The exact inputs the delta was computed from. Auditable after the fact. */
  basis: Record<string, unknown>;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * A shaped value multiplier: bigger jobs move reputation more, but sub-linearly,
 * so one enormous job cannot buy a tier. sqrt keeps the ordering while flattening
 * the tail.
 */
function valueFactor(valueAtRisk: number): number {
  return Math.sqrt(Math.max(0, valueAtRisk));
}

/**
 * Compute the RepID delta for one outcome.
 *
 * Pure — no clock, no I/O — so a reviewer recomputing a delta from a stored
 * OutcomeRecord gets exactly what the system got.
 */
export function deltaFor(record: OutcomeRecord): DeltaResult {
  const conf = clamp(record.halCalibratedConfidence, 0, 1);
  const vf = valueFactor(record.valueAtRisk);
  let effectiveClass = record.class;
  let demotionReason: string | undefined;

  // ── DEMOTION: unanchored success above the value threshold ────────────────
  const claimsSuccess =
    record.class === OutcomeClass.SUCCESS_AUDITED || record.class === OutcomeClass.SUCCESS_UNAUDITED;
  const hasPaymentProof = typeof record.x402PaymentProof === 'string' && record.x402PaymentProof.length > 0;

  if (claimsSuccess && record.valueAtRisk > PAYMENT_PROOF_REQUIRED_ABOVE && !hasPaymentProof) {
    // NOT refused — demoted. An unproven success is not a lie, it is merely
    // unverifiable, and unverifiable work should earn near nothing rather than
    // be treated as fraud.
    effectiveClass = OutcomeClass.UNCERTAIN;
    demotionReason = `success claimed at value ${record.valueAtRisk} (> ${PAYMENT_PROOF_REQUIRED_ABOVE}) with no linked x402 payment proof — unanchored success earns nothing`;
  }

  // A SUCCESS_AUDITED claim with no audit evidence is really SUCCESS_UNAUDITED.
  if (
    effectiveClass === OutcomeClass.SUCCESS_AUDITED &&
    (record.validationResponse === undefined || record.validationResponse === null) &&
    conf < 0.5
  ) {
    effectiveClass = OutcomeClass.SUCCESS_UNAUDITED;
    demotionReason = 'audited success claimed with no Validation response and low calibrated confidence';
  }

  let delta = 0;
  switch (effectiveClass) {
    case OutcomeClass.SUCCESS_AUDITED:
      // Strong positive, but capped and scaled by BOTH value and confidence.
      delta = clamp(2 * vf * conf, 0, MAX_POSITIVE_DELTA);
      break;

    case OutcomeClass.SUCCESS_UNAUDITED:
      // Small positive. Delivering without audit is worth something, not much.
      delta = clamp(0.5 * vf * conf, 0, MAX_POSITIVE_DELTA / 5);
      break;

    case OutcomeClass.FAILURE_AGENT_FAULT: {
      // THE CORE RULE. The penalty scales with the confidence that was asserted.
      // A confident error is a claim the agent had no business making; a hedged
      // error is an honest mistake.
      //
      // ORDER MATTERS HERE, and the first version got it wrong. Clamping the
      // FINAL product destroyed the confidence gradient exactly where it matters
      // most: at high value both a hedged and a confident error hit the floor,
      // collapsing a 3.35x spread to 1.74x — so at large stakes, confidence
      // became almost free. Caught by `a CONFIDENT error costs more than a
      // HEDGED error`.
      //
      // So the VALUE component is capped first, and the confidence amplifier is
      // applied to the capped base. The gradient then survives at every value.
      const cappedValueBase = clamp(6 * vf, 0, 30);
      const confidenceAmplifier = 1 + 3 * conf; // 1x fully hedged .. 4x fully confident
      delta = clamp(-cappedValueBase * confidenceAmplifier, MAX_NEGATIVE_DELTA, 0);
      break;
    }

    case OutcomeClass.REFUSED_CORRECTLY:
      // Restraint is work and must pay. Small, flat, and NOT scaled by value —
      // otherwise refusing big jobs would become a farming strategy.
      delta = 2;
      break;

    case OutcomeClass.FAILURE_COUNTERPARTY:
      // Not the agent's fault. A whisper of negative so a counterparty-failure
      // flood is still visible, but effectively neutral.
      delta = -0.5;
      break;

    case OutcomeClass.FAILURE_INFRA:
      // Nobody's fault. Zero, deliberately: penalising infra failure would push
      // agents to hide outages rather than report them.
      delta = 0;
      break;

    case OutcomeClass.UNCERTAIN:
      delta = 0;
      break;
  }

  return {
    delta: Math.round(delta * 100) / 100,
    effectiveClass,
    ...(demotionReason ? { demotionReason } : {}),
    basis: {
      claimedClass: record.class,
      calibratedConfidence: conf,
      valueAtRisk: record.valueAtRisk,
      valueFactor: Math.round(vf * 1000) / 1000,
      hasPaymentProof,
      validationResponse: record.validationResponse ?? null,
    },
  };
}

/**
 * Apply a delta to a previous score, producing the `updated_components` value
 * the fold circuit commits to.
 *
 * Clamped to the canonical [10, 10000] RepID range — the same bounds
 * `src/engine/repid-update.ts` enforces, so the folded value can never describe
 * a score the engine itself could not hold.
 */
export function applyDelta(prevScore: number, delta: number): number {
  return Math.round(clamp(prevScore + delta, 10, 10000));
}

/**
 * The `new_outcome` field the Rust fold consumes, as a non-negative u32.
 *
 * The circuit's `weighted_update` is unsigned and saturating, so a signed delta
 * is encoded as an offset from a fixed midpoint rather than as a negative
 * number. Wrapping a negative into field-space is the classic soundness hole the
 * range-check AIR exists to close, and it is not reintroduced here.
 */
export const DELTA_ENCODING_MIDPOINT = 100_000;
/**
 * Fixed-point resolution. 100 = two decimal places, matching the precision
 * `deltaFor` already rounds to — so encode/decode is EXACT rather than lossy.
 * The first version used 10 (one decimal) and silently turned 24.75 into 24.8;
 * a reputation system that rounds its own deltas differently on the way into the
 * commitment is committing to a number it did not compute.
 */
export const DELTA_ENCODING_SCALE = 100;

export function encodeDeltaForFold(delta: number): number {
  const encoded = Math.round(DELTA_ENCODING_MIDPOINT + delta * DELTA_ENCODING_SCALE);
  if (encoded < 0) throw new Error(`delta ${delta} underflows the fold encoding — refuse rather than wrap`);
  return encoded;
}

export function decodeDeltaFromFold(encoded: number): number {
  return (encoded - DELTA_ENCODING_MIDPOINT) / DELTA_ENCODING_SCALE;
}
