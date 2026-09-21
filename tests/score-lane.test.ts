/**
 * E5 — score_lane only from engine-verified evidence. SYNTHETIC.
 */
import { scoreLaneFromGrounding } from '../src/scoring/score-lane';

describe('E5 score_lane', () => {
  it('ungrounded / rejected evidence has no score_lane', () => {
    expect(scoreLaneFromGrounding(0)).toEqual({ score_lane: null, reason: 'not_engine_verified' });
  });

  it('engine-verified evidence is the only lane', () => {
    expect(scoreLaneFromGrounding('high')).toEqual({ score_lane: 'engine_verified', reason: null });
    expect(scoreLaneFromGrounding('low')).toEqual({ score_lane: 'engine_verified', reason: null });
  });
});
