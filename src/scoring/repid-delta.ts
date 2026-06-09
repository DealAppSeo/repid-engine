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
const FLOOR = 0;

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
    const raw = 1 + (score - 0.5) * 4; // 0.5 → +1, 1.0 → +3, 0.0 → -1
    delta_calculated = Math.round(raw * 10) / 10; // 1 decimal precision
    reason =
      score >= 0.5
        ? `HAL clean (score=${score.toFixed(2)}): baseline +1 + bonus`
        : `HAL clean but low quality (score=${score.toFixed(2)}): reduced reward`;
  }

  delta_calculated = clampDelta(delta_calculated);

  let delta_applied: number;
  if (vesting_cliff_active && delta_calculated < 0) {
    delta_applied = 0;
    reason += ' (vesting-cliff: negative absorbed)';
  } else {
    delta_applied = delta_calculated;
  }

  // Floor protection: never push current_repid below FLOOR.
  const projected = current_repid + delta_applied;
  if (projected < FLOOR) {
    delta_applied = FLOOR - current_repid; // bring exactly to floor
    reason += ` (floor-protected: projected=${projected} clamped to ${FLOOR})`;
  }

  return { delta_calculated, delta_applied, reason };
}
