/**
 * Sprint A7 — RepID delta calculation for the score-event pipeline.
 *
 * Pure function: given a HAL evaluation result + agent state, returns the
 * RepID delta the event "earned" (delta_calculated) plus what actually
 * applies to the agent (delta_applied). The two diverge during the vesting
 * cliff window where negatives are absorbed but positives still apply.
 *
 * Tuning thresholds will move in Sprint D2.
 */

import { REPID_MIN } from './repid-clamp';

export type HALDecision = 'clean' | 'flagged' | 'vetoed' | 'abstain';

export interface DeltaInput {
  hal_score: number;          // 0..1 (post-A6); pre-A6 may emit dissonance scale
  hal_decision: HALDecision;
  current_repid: number;
  agent_tier: string;         // PROBATIONARY | EARNING | ESTABLISHED | AUTONOMOUS | VETERAN
  vesting_cliff_active: boolean;
  task_complexity?: number;   // 0..1, optional (reserved for D2)
}

export interface DeltaOutput {
  delta_calculated: number;
  delta_applied: number;
  reason: string;
}

const MAX_POSITIVE = 5;
const MAX_NEGATIVE = -10;

/**
 * TWO FLOORS, ONE SCORING PATH.
 *
 * This module used to carry `const FLOOR = 0` while `repid-clamp.ts` exports
 * `REPID_MIN = 10` and `repid_agents_current_repid_check` requires
 * `current_repid >= 10`. So the delta formula believed 0 was reachable and the
 * database did not. The literal is now gone: the reconciled floor is imported
 * from the same module the clamp uses, so there is exactly one place `10` is
 * written down.
 *
 * WHY THE LEGACY 0 IS STILL THE DEFAULT. Raising the floor to 10 changes a
 * STORED ledger value (`repid_delta_applied`) for any agent whose projected
 * score lands in 0..9 — i.e. `current_repid` in 10..19 taking a negative delta.
 * It cannot change the resulting score, because `clampRepid` already pins that
 * window to 10 either way; it changes the recorded delta from a movement that
 * could not have happened (-10 against a 5-point drop) to the one that did.
 * That is still a live-path behaviour change, so it lands inert behind
 * `REPID_DELTA_FLOOR_RECONCILED` (default OFF) and is Sean's flip, not ours.
 *
 * Measured 2026-08-03 against Trinity prod: `SELECT count(*) FROM repid_agents
 * WHERE current_repid BETWEEN 10 AND 19` = 0, and `min(current_repid)` = 60 —
 * so the flip has no live witness today. That is a reason it is cheap to flip,
 * not a reason to flip it here.
 */
const LEGACY_FLOOR = 0;

/** The floor a delta is protected against. `REPID_MIN` once the flag is flipped. */
export function deltaFloor(): number {
  return process.env.REPID_DELTA_FLOOR_RECONCILED === 'true' ? REPID_MIN : LEGACY_FLOOR;
}

function clampDelta(d: number): number {
  if (d > MAX_POSITIVE) return MAX_POSITIVE;
  if (d < MAX_NEGATIVE) return MAX_NEGATIVE;
  return d;
}

export function computeDelta(input: DeltaInput): DeltaOutput {
  const { hal_decision, hal_score, current_repid, vesting_cliff_active } = input;

  let delta_calculated: number;
  let reason: string;

  if (hal_decision === 'vetoed') {
    delta_calculated = -10;
    reason = 'HAL vetoed: hallucination or constitutional block';
  } else if (hal_decision === 'abstain') {
    // A2 — HAL abstained: not a checkable claim (opinion/question, no FALSE quorum). No truth
    // was asserted, so no reward and NO penalty (Micah 6:8 humility — don't judge where there's
    // nothing to judge). Kills the documented opinion/time-sensitive over-penalization.
    delta_calculated = 0;
    reason = 'HAL abstained: not a checkable factual claim — no delta';
  } else if (hal_decision === 'flagged') {
    // A2 — flagged = a single FALSE with no independent quorum (or borderline score). Surfaced for
    // review but NOT a confirmed error, so it no longer carries a penalty (was -2). Only a real
    // FALSE quorum ('vetoed') costs RepID.
    delta_calculated = 0;
    reason = 'HAL flagged: unconfirmed (no FALSE quorum) — surfaced, no delta';
  } else {
    // clean
    const score = Number.isFinite(hal_score) ? hal_score : 0.5;

    // ORIENTATION — fixed 2026-08-17 (Sean: the clean branch consumes QUALITY).
    //
    // `hal_score` is a hallucination RISK score: HIGH IS BAD. src/hal/lib/score.ts says so, and
    // `deriveHalDecision` confirms it operationally — it returns 'clean' only BELOW 0.40.
    //
    // This branch previously fed that risk value straight into a reward curve written for
    // quality, and nothing inverted it anywhere in between (src/scoring/pipeline.ts passes one
    // value to both functions). Measured consequence: over the domain the pipeline can actually
    // produce, reward INCREASED with risk — a perfectly grounded claim was penalised -1.0, the
    // best-paid clean event sat at risk 0.388 just under the flag boundary, and the documented
    // ceiling was unreachable because anything >= 0.40 is 'flagged' and pays 0. A truthful agent
    // that tuned its prose to the boundary out-earned an honest one at every detector accuracy.
    // Full measurement: reports/2026-08-17/REPID-INCENTIVE-AUDIT.md (`npm run repid:sim`).
    //
    // The conversion happens HERE, once, rather than at the callers: `hal_score` means risk
    // everywhere else in this system, so renaming the field or asking each caller to invert would
    // spread a units conversion across every call site — which is how this class of bug starts.
    const quality = 1 - score;
    const raw = 1 + (quality - 0.5) * 4; // quality 1.0 → +3, 0.5 → +1, 0.0 → -1
    delta_calculated = Math.round(raw * 10) / 10; // 1 decimal precision
    reason =
      quality >= 0.5
        ? `HAL clean (risk=${score.toFixed(2)}, quality=${quality.toFixed(2)}): baseline +1 + bonus`
        : `HAL clean but low quality (risk=${score.toFixed(2)}, quality=${quality.toFixed(2)}): reduced reward`;
  }

  delta_calculated = clampDelta(delta_calculated);

  let delta_applied: number;
  if (vesting_cliff_active && delta_calculated < 0) {
    delta_applied = 0;
    reason += ' (vesting-cliff: negative absorbed)';
  } else {
    delta_applied = delta_calculated;
  }

  // Floor protection: never push current_repid below the floor.
  //
  // Two guards that are no-ops at the legacy floor and load-bearing at the
  // reconciled one:
  //   `delta_applied < 0` — floor protection exists to soften a PENALTY. At
  //     FLOOR=0 a non-negative delta could only trip this with current_repid<0;
  //     at FLOOR=10 an agent already below 10 would trip it on any delta.
  //   `Math.min(0, …)` — never let floor protection flip a penalty into a
  //     REWARD. `FLOOR - current_repid` is <= 0 for every in-range agent, but is
  //     POSITIVE for a sub-floor one (current_repid=2 → +8), which would turn a
  //     veto into an +8 gift. It clamps the magnitude, it never changes the sign.
  const floor = deltaFloor();
  const projected = current_repid + delta_applied;
  if (delta_applied < 0 && projected < floor) {
    delta_applied = Math.min(0, floor - current_repid); // bring at most to the floor
    reason += ` (floor-protected: projected=${projected} clamped to ${floor})`;
  }

  return { delta_calculated, delta_applied, reason };
}
