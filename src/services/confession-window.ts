/**
 * confession-window.ts — disclosure has to be PROMPT to be worth the full
 * discount.
 *
 * THE ARBITRAGE THIS CLOSES. `repid-confession.ts` makes a self-reported failure
 * cost 40% of a detected one. With no time limit, the optimal play is not
 * honesty — it is *waiting*: conceal, watch for signs that a detector is closing
 * in, and confess at the last possible moment. That collects the discount with
 * none of the behaviour the discount is paying for. Just culture buys EARLY
 * information; a confession filed once detection is imminent tells the system
 * something it was about to learn anyway, and is worth much less.
 *
 * WHY LATE DISCLOSURE IS STILL DISCOUNTED, AND NOT CHARGED FULL PRICE. This is
 * the part that is easy to get backwards, and getting it backwards rebuilds the
 * hole the whole mechanism exists to close.
 *
 * If a late confession cost exactly what detection costs, then an agent holding
 * an undisclosed failure faces: confess and pay P for certain, or stay quiet and
 * pay P only if caught. Concealment would strictly dominate again — the same
 * structural failure as having no confession channel at all, arrived at from the
 * other direction. So the ordering that must hold is:
 *
 *     prompt disclosure  <  late disclosure  <  being caught
 *
 * all three strict. Waiting is punished. Hiding is punished more. Every test
 * below exists to keep those two inequalities from collapsing into one.
 *
 * TIMING EVIDENCE IS SELF-REPORTED, AND THAT IS FINE. The agent asserts when the
 * failure happened. That looks like a hole until you notice what it converts the
 * attack into: an agent that back-dates a failure to reach the window is making a
 * checkable claim about an event with an objective timestamp in settlement and
 * logs. A timing arbitrage becomes a falsifiable lie — a much better problem to
 * have, and one the existing `hal_verified` / `peer_endorsement_required`
 * columns already anticipate.
 *
 * MISSING TIMING IS `NOT_CHECKED`, AND IS PRICED AS LATE. Nobody looked, so the
 * confession cannot be shown to be prompt. It is priced conservatively — the
 * cautious direction, since the alternative is granting the best rate on no
 * evidence — and the result SAYS `NOT_CHECKED` rather than reporting a window it
 * never measured.
 */

/** Hours after a failure within which disclosure earns the full discount. */
export const SELF_REPORT_WINDOW_HOURS = 24;

/**
 * Discount for disclosure made after the window closed.
 *
 * Strictly between the prompt discount and 1. `confession-window.test.ts` pins
 * both inequalities: a "normalisation" that moved this to 1.0 would silently
 * make concealment dominant again, and that failure is invisible in any test
 * that only checks a confession is cheaper than nothing.
 */
export const LATE_SELF_REPORT_DISCOUNT = 0.7;

export type DisclosureTiming =
  /** Inside the window, with timestamps for both ends. */
  | 'PROMPT'
  /** Outside the window, with timestamps for both ends. */
  | 'LATE'
  /** No usable timing. Priced as LATE; never reported as PROMPT. */
  | 'NOT_CHECKED';

export interface TimingInput {
  /** When the failure occurred, per the agent. Epoch ms. */
  failureAt?: number | null;
  /** When the confession was filed. Epoch ms. */
  confessedAt?: number | null;
  /** Override the window. Production reads `repid_config`. */
  windowHours?: number;
}

export interface TimingResult {
  timing: DisclosureTiming;
  /** Hours between failure and disclosure, when both are known. */
  ageHours: number | null;
  windowHours: number;
  /** Why this timing was reached — quoted in the ledger so it is auditable. */
  reason: string;
}

const HOUR_MS = 3_600_000;

function usableTimestamp(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Classify a disclosure as prompt, late, or untimed. Pure — no clock, no I/O —
 * so a reviewer recomputing the timing from a stored confession gets exactly
 * what the system got.
 */
export function classifyDisclosureTiming(input: TimingInput): TimingResult {
  const windowHours =
    typeof input.windowHours === 'number' && Number.isFinite(input.windowHours) && input.windowHours >= 0
      ? input.windowHours
      : SELF_REPORT_WINDOW_HOURS;

  const failureAt = usableTimestamp(input.failureAt);
  const confessedAt = usableTimestamp(input.confessedAt);

  if (failureAt === null || confessedAt === null) {
    return {
      timing: 'NOT_CHECKED',
      ageHours: null,
      windowHours,
      reason: 'no usable failure/disclosure timestamps — priced as late rather than granted the prompt rate on no evidence',
    };
  }

  const ageHours = (confessedAt - failureAt) / HOUR_MS;

  if (ageHours < 0) {
    // A confession dated BEFORE the failure it describes. The obvious use is to
    // back-date a failure into the window; the arithmetic overshot. Refuse the
    // prompt rate rather than reward an impossible ordering.
    return {
      timing: 'NOT_CHECKED',
      ageHours,
      windowHours,
      reason: 'disclosure is dated before the failure it describes — timing is not usable',
    };
  }

  if (ageHours <= windowHours) {
    return {
      timing: 'PROMPT',
      ageHours,
      windowHours,
      reason: `disclosed ${ageHours.toFixed(2)}h after the failure, inside the ${windowHours}h window`,
    };
  }

  return {
    timing: 'LATE',
    ageHours,
    windowHours,
    reason: `disclosed ${ageHours.toFixed(2)}h after the failure, outside the ${windowHours}h window`,
  };
}

/**
 * The discount multiplier this timing earns, for
 * `reducedPenalty(detected, discount)`.
 *
 * `NOT_CHECKED` deliberately returns the same value as `LATE`. The two are
 * priced alike and reported differently: pricing is a decision that must be made
 * either way, while the report is a claim about evidence, and collapsing the
 * second into the first is how "we did not look" becomes "it passed".
 */
export function discountForTiming(
  timing: DisclosureTiming,
  promptDiscount: number,
  lateDiscount: number = LATE_SELF_REPORT_DISCOUNT,
): number {
  return timing === 'PROMPT' ? promptDiscount : lateDiscount;
}

/**
 * Does this pair of discounts preserve the ordering the mechanism depends on?
 *
 * Exported so the invariant can be asserted wherever the numbers are read from
 * config rather than only where they are declared — a live `repid_config` edit
 * can break this exactly as easily as a code change, and more quietly.
 */
export function orderingHolds(promptDiscount: number, lateDiscount: number): boolean {
  return promptDiscount > 0 && promptDiscount < lateDiscount && lateDiscount < 1;
}
