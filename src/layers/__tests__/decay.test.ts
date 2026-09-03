/**
 * decay — SHAPE ONLY. No tuned constant appears in this file.
 *
 * This file previously asserted the tuned decay factor (a specific value at the
 * RepID cap) and the tuned decay floor as literal expected results. Those are
 * exactly what `config/scoring-params.ts` was created to keep out of a PUBLIC
 * repository, and they survived that refactor because this directory was not in
 * `jest.config.js` `roots` — nothing ran the file, so nothing objected.
 *
 * See the header of `challenge-scoring.test.ts` in this directory for the full
 * account and the rule. In short: assert the SHAPE (monotonicity, clamping, the
 * floor at the ledger minimum, integer output), never a number only production
 * tuning could produce. Every parameter below is pinned locally to a synthetic
 * value and every expectation derives from those.
 *
 * REPID_MAX (10000) and REPID_MIN (10) DO appear here on purpose: they are the
 * published tier bounds, documented in CLAUDE.md and in the tier ladder, not
 * tuning. `decay.ts` keeps them in the repo for the same reason.
 */
import { computeDecayFactor, applyDecay } from '../decay';
import { __resetScoringParamsCache } from '../../config/scoring-params';

/** Synthetic. Chosen so the unclamped band is wide enough to observe gradients in. */
const SYNTHETIC = {
  REPID_DECAY_LAMBDA: '0.4',
  REPID_DECAY_K: '0.2',
  REPID_DECAY_FLOOR: '0.5',
  REPID_DECAY_CAP: '1.0',
} as const;

const LAMBDA = 0.4;
const K = 0.2;
const FLOOR = 0.5;
const CAP = 1.0;
const REPID_MAX = 10000;
const REPID_MIN = 10;

let saved: Record<string, string | undefined>;

const pin = (over: Record<string, string> = {}) => {
  for (const [k, v] of Object.entries({ ...SYNTHETIC, ...over })) process.env[k] = v;
  __resetScoringParamsCache();
};

beforeEach(() => {
  saved = {};
  for (const k of Object.keys(SYNTHETIC)) saved[k] = process.env[k];
  pin();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetScoringParamsCache();
});

describe('computeDecayFactor', () => {
  it('matches the stated model: 1 - lambda * e^(-k*activity) * sqrt(score/MAX)', () => {
    const expected = 1 - LAMBDA * Math.exp(-K * 7) * Math.sqrt(4000 / REPID_MAX);
    expect(computeDecayFactor({ currentRepId: 4000, activity30d: 7 })).toBeCloseTo(expected, 10);
  });

  it('decays a HIGHER score faster — reputation at the top is harder to keep', () => {
    const factors = [100, 1000, 4000, REPID_MAX].map((s) =>
      computeDecayFactor({ currentRepId: s, activity30d: 0 }),
    );
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]!).toBeLessThan(factors[i - 1]!);
    }
  });

  it('decays an ACTIVE agent less — activity is the thing that arrests decay', () => {
    const factors = [0, 1, 5, 15, 30].map((a) =>
      computeDecayFactor({ currentRepId: REPID_MAX, activity30d: a }),
    );
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]!).toBeGreaterThan(factors[i - 1]!);
    }
  });

  it('approaches the cap as activity grows, and never exceeds it', () => {
    expect(computeDecayFactor({ currentRepId: REPID_MAX, activity30d: 10_000 })).toBeCloseTo(CAP, 6);
    for (const a of [0, 1, 30, 1000, 1e9]) {
      expect(computeDecayFactor({ currentRepId: REPID_MAX, activity30d: a })).toBeLessThanOrEqual(CAP);
    }
  });

  it('never falls below the floor, however extreme the inputs', () => {
    // A floor high enough that the unclamped model would go straight through it.
    pin({ REPID_DECAY_LAMBDA: '0.9', REPID_DECAY_FLOOR: '0.8' });
    const unclamped = 1 - 0.9 * Math.sqrt(REPID_MAX / REPID_MAX);
    expect(unclamped).toBeLessThan(0.8); // the model WOULD have gone lower
    expect(computeDecayFactor({ currentRepId: REPID_MAX, activity30d: 0 })).toBe(0.8);
  });

  it('is a factor, not a delta — always in (0, 1]', () => {
    for (const s of [REPID_MIN, 100, 5000, REPID_MAX]) {
      for (const a of [0, 3, 30]) {
        const f = computeDecayFactor({ currentRepId: s, activity30d: a });
        expect(f).toBeGreaterThan(0);
        expect(f).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('applyDecay', () => {
  it('applies the factor to the score', () => {
    const f = computeDecayFactor({ currentRepId: 4000, activity30d: 3 });
    expect(applyDecay(4000, 3)).toBe(Math.round(4000 * f));
  });

  it('never takes an agent below the RepID floor of 10', () => {
    // The sqrt(score/MAX) term means a low score barely decays on its own, so raising
    // lambda does NOT reach the clamp — the first draft of this test did that and passed
    // with the clamp deleted. The cap is what can drive the factor down at any score, so
    // that is what this pins. Caught by sabotage, not by review.
    pin({ REPID_DECAY_CAP: '0.1', REPID_DECAY_FLOOR: '0.01' });
    expect(computeDecayFactor({ currentRepId: REPID_MIN, activity30d: 0 })).toBe(0.1);
    expect(Math.round(REPID_MIN * 0.1)).toBeLessThan(REPID_MIN); // unclamped would be 1
    expect(applyDecay(REPID_MIN, 0)).toBe(REPID_MIN);
    expect(applyDecay(50, 0)).toBe(REPID_MIN); // round(5) = 5, clamped up to the floor
  });

  it('returns an integer — the ledger stores whole RepID', () => {
    for (const s of [11, 137, 4150, 9999, REPID_MAX]) {
      for (const a of [0, 5, 30]) {
        expect(Number.isInteger(applyDecay(s, a))).toBe(true);
      }
    }
  });

  it('is never an increase — decay only ever costs', () => {
    for (const s of [REPID_MIN, 500, 4000, REPID_MAX]) {
      for (const a of [0, 5, 30, 1000]) {
        expect(applyDecay(s, a)).toBeLessThanOrEqual(s);
      }
    }
  });
});
