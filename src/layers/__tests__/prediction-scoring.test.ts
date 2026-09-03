/**
 * prediction-scoring — SHAPE ONLY, and pinned.
 *
 * This file PASSED while carrying a tuned constant: the φ³ bound below read
 * `-PHI_CUBED * 15 * 3 - 1`, where the 15 was the base reward that
 * `config/scoring-params.ts` moved to the environment. A leak inside a loose
 * `toBeGreaterThan` is the hardest kind to notice — nothing ever goes red — which is
 * why the params are now pinned locally and the bound is derived from the pinned
 * value instead of a magic number.
 *
 * φ and φ³ stay literal: φ = 1.618… is published canon in CLAUDE.md, not tuning.
 *
 * See `challenge-scoring.test.ts` in this directory for the full account, and
 * `tests/scoring-tuning-not-in-repo.test.ts` for the mechanical guard.
 */
import { scorePrediction, PHI_CUBED } from '../prediction-scoring';
import { __resetScoringParamsCache } from '../../config/scoring-params';

const BASE_REWARD = 20;   // synthetic
const TAU_DAYS = 45;      // synthetic

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {
    REPID_PREDICTION_BASE_REWARD: process.env['REPID_PREDICTION_BASE_REWARD'],
    REPID_PREDICTION_TAU_DAYS: process.env['REPID_PREDICTION_TAU_DAYS'],
  };
  process.env['REPID_PREDICTION_BASE_REWARD'] = String(BASE_REWARD);
  process.env['REPID_PREDICTION_TAU_DAYS'] = String(TAU_DAYS);
  __resetScoringParamsCache();
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetScoringParamsCache();
});

describe('scorePrediction', () => {
  test('Correct high confidence → large positive', () => {
    expect(scorePrediction({pStated:0.9,pCorrect:1,daysAgo:0,networkImportance:1.0}))
      .toBeGreaterThan(1);
  });
  test('Wrong high confidence → large negative', () => {
    expect(scorePrediction({pStated:0.9,pCorrect:0,daysAgo:0,networkImportance:1.0}))
      .toBeLessThan(-5);
  });
  test('Correct 50% → small positive', () => {
    const r = scorePrediction({pStated:0.5,pCorrect:1,daysAgo:0,networkImportance:1.0});
    expect(r).toBeGreaterThan(0); expect(r).toBeLessThan(20);
  });
  test('Wrong low confidence → tiny negative', () => {
    const r = scorePrediction({pStated:0.1,pCorrect:0,daysAgo:0,networkImportance:1.0});
    expect(r).toBeLessThan(0); expect(r).toBeGreaterThan(-5);
  });
  test('φ³ floor cap prevents infinite penalty', () => {
    // The bound is BASE_REWARD × φ³ × maxImportance, derived from the pinned value.
    // It read `* 15 *` before, hardcoding the tuned base reward into a public repo
    // inside an inequality that could never fail loudly enough to be noticed.
    // Rounded the way the function itself rounds (1dp). The old line carried a bare
    // `- 1` of slack to absorb this; matching the real rounding pins the bound exactly
    // instead of leaving a unit of room a regression could hide in.
    const worst = Math.round(-PHI_CUBED * BASE_REWARD * 3 * 10) / 10;
    expect(scorePrediction({pStated:0.99,pCorrect:0,daysAgo:0,networkImportance:3.0}))
      .toBeGreaterThanOrEqual(worst);
    // And the cap actually binds: without the φ³ floor, log(1/(1-0.99)) would run away.
    expect(Math.log(1 / (1 - 0.99 + 1e-9))).toBeGreaterThan(PHI_CUBED);
  });

  test('importance is clamped to [1,3] — no single prediction buys unbounded weight', () => {
    const at3 = scorePrediction({pStated:0.8,pCorrect:1,daysAgo:0,networkImportance:3.0});
    expect(scorePrediction({pStated:0.8,pCorrect:1,daysAgo:0,networkImportance:99})).toBe(at3);
    const at1 = scorePrediction({pStated:0.8,pCorrect:1,daysAgo:0,networkImportance:1.0});
    expect(scorePrediction({pStated:0.8,pCorrect:1,daysAgo:0,networkImportance:-5})).toBe(at1);
  });

  test('time decay follows the pinned tau, not a hardcoded horizon', () => {
    const now = scorePrediction({pStated:0.9,pCorrect:1,daysAgo:0,networkImportance:1.0});
    const oneTau = scorePrediction({pStated:0.9,pCorrect:1,daysAgo:TAU_DAYS,networkImportance:1.0});
    // One time-constant in, the weight is 1/e of its starting value.
    expect(oneTau).toBeCloseTo(Math.round(now * Math.exp(-1) * 10) / 10, 1);
  });
  test('Time decay: old predictions count less', () => {
    const recent = scorePrediction({pStated:0.9,pCorrect:1,daysAgo:0,networkImportance:1.0});
    const old = scorePrediction({pStated:0.9,pCorrect:1,daysAgo:180,networkImportance:1.0});
    expect(Math.abs(recent)).toBeGreaterThan(Math.abs(old));
  });
  test('Higher importance amplifies score', () => {
    const n = scorePrediction({pStated:0.8,pCorrect:1,daysAgo:0,networkImportance:1.0});
    const h = scorePrediction({pStated:0.8,pCorrect:1,daysAgo:0,networkImportance:3.0});
    expect(Math.abs(h)).toBeGreaterThan(Math.abs(n));
  });
  test('Negative daysAgo throws', () => {
    expect(() => scorePrediction({pStated:0.8,pCorrect:1,daysAgo:-1,networkImportance:1.0}))
      .toThrow('daysAgo cannot be negative');
  });
});
