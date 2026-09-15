/**
 * E5 — score_lane is only assigned from engine-verified evidence.
 * Never a caller string, never a guessed lane.
 */
import type { GVerified } from './grounding';

export type ScoreLane = 'engine_verified';

export function scoreLaneFromGrounding(g: GVerified): {
  score_lane: ScoreLane | null;
  reason: string | null;
} {
  if (g === 'high' || g === 'low') {
    return { score_lane: 'engine_verified', reason: null };
  }
  return { score_lane: null, reason: 'not_engine_verified' };
}
