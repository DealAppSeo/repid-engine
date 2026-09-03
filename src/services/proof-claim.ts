/**
 * What did this proof actually CLAIM — and is the claim capable of being false?
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE GAP [MEASURED 2026-09-03]
 * ════════════════════════════════════════════════════════════════════════════════
 * The passport reported `cryptographically_verifiable: true` and never said what was
 * verified. The threshold — the entire substance of a range proof — was not in the
 * response at all.
 *
 * That matters here more than it would elsewhere, because the threshold is the tier
 * FLOOR, and the floor of the lowest tier is 0. So a probationary agent's proof
 * asserts `score >= 0`, which every score in the system satisfies: the RepID clamp
 * floor is 10, so no valid score could ever fail it. Measured across agents holding a
 * real proof, a large minority — every probationary one and several with no tier
 * recorded — carry exactly that claim.
 *
 * A vacuous claim is not a broken proof, and this module must not say it is. The
 * proof still does real work: `agent_id`, `threshold` and the score are all public
 * circuit inputs, so it binds a specific agent to a specific score tamper-evidently.
 * What it does NOT do for those agents is discriminate — the inequality is satisfied
 * by every possible score, so verifying it tells you nothing you did not already know
 * from reading the score beside it.
 *
 * Both halves have to be said at once, and saying only the first is how a reader
 * concludes a threshold was cleared when nothing could have failed it. Same shape as
 * the anchor ladder in `anchor-status.ts`: a true statement that a reader over-reads
 * because the qualifier is missing.
 *
 * NOTHING ABOUT SCORING CHANGES HERE. Whether the tier floor is the right threshold
 * for a new agent is a product decision with an owner — this only stops the surface
 * implying more than the proof establishes.
 */
import { REPID_MIN } from '../scoring/repid-clamp';

export type ThresholdClaim = 'BINDING' | 'VACUOUS' | 'UNKNOWN';

export interface ProofClaim {
  /** The threshold the proof asserts the score meets. `null` when not recorded. */
  threshold: number | null;
  /** The claim in words, e.g. `score >= 999`. `null` when the threshold is unknown. */
  statement: string | null;
  claim: ThresholdClaim;
  note: string;
}

/**
 * A threshold is VACUOUS when no valid score could fail it.
 *
 * The bound is `REPID_MIN`, not zero: scores are clamped to [10, 10000], so
 * `score >= 10` is exactly as unfalsifiable as `score >= 0` and must be labelled the
 * same. Anchoring on the clamp rather than on 0 is the difference between a rule and
 * a coincidence — a future tier floor of 5 would otherwise read as BINDING.
 */
export function classifyThreshold(threshold: number | null | undefined): ThresholdClaim {
  if (threshold === null || threshold === undefined || !Number.isFinite(Number(threshold))) {
    return 'UNKNOWN';
  }
  return Number(threshold) <= REPID_MIN ? 'VACUOUS' : 'BINDING';
}

export const CLAIM_NOTES: Record<ThresholdClaim, string> = {
  BINDING:
    'The proof asserts the score clears this threshold, and a lower score would fail ' +
    'verification. Verifying it establishes the claim.',
  VACUOUS:
    'The threshold is at or below the minimum possible RepID, so EVERY valid score ' +
    'satisfies it and no score could have failed. The proof is still tamper-evidence ' +
    'binding this agent to this exact score — but verifying the threshold itself ' +
    'establishes nothing beyond what the score already states. This is what a new ' +
    'agent gets: the lowest tier floor is zero.',
  UNKNOWN:
    'No threshold is recorded with this proof, so we cannot say what it claims or ' +
    'whether the claim could have failed. Not asserted either way.',
};

/** Build the claim block from a proof row's `statement` json. */
export function proofClaim(statement: unknown): ProofClaim {
  const raw =
    statement && typeof statement === 'object'
      ? (statement as Record<string, unknown>)['threshold']
      : undefined;
  const n = raw === null || raw === undefined ? null : Number(raw);
  const threshold = n !== null && Number.isFinite(n) ? n : null;
  const claim = classifyThreshold(threshold);
  return {
    threshold,
    statement: threshold === null ? null : `score >= ${threshold}`,
    claim,
    note: CLAIM_NOTES[claim],
  };
}
