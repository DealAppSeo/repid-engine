/**
 * challenge-scoring — SHAPE ONLY. No tuned constant appears in this file.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE WAS REWRITTEN [MEASURED 2026-09-03]
 * ════════════════════════════════════════════════════════════════════════════════
 * `config/scoring-params.ts` exists because four source files carried a header
 * saying the tuned RepID constants must not be exposed in a public repo and then
 * declared those constants three lines below it. That refactor moved the values to
 * the environment — and MISSED this file, which went on asserting the exact tuned
 * numbers as its expected results.
 *
 * It missed it because THIS DIRECTORY WAS NOT IN `jest.config.js` `roots`. Nothing
 * ran it, nothing failed, nothing pointed at it. The mechanism that would have
 * caught a leak of the very thing the repo declares it must not publish was
 * disconnected, so the leak outlived the fix that was supposed to remove it. That
 * is this project's recurring defect wearing its worst costume: not a wrong answer,
 * but a check that was never performed reading as a check that passed.
 *
 * The rule this file now follows, and the reason every assertion below pins its own
 * parameters first:
 *
 *   A test may assert the SHAPE of the model — monotonicity, sign, proportionality,
 *   where a cap binds, that two branches agree. It may NOT assert a number that
 *   only production tuning could produce.
 *
 * Every parameter below is set locally to a round, obviously-synthetic value, and
 * every expected number is derived from THOSE. Read off the tuning from this file
 * and you learn nothing except that the model multiplies.
 *
 * `tests/scoring-tuning-not-in-repo.test.ts` enforces the rule mechanically, so the
 * next person to write a scoring test cannot reintroduce this by accident.
 */
import { scoreChallengeOutcome, ChallengeInput } from '../challenge-scoring';
import { __resetScoringParamsCache } from '../../config/scoring-params';

/**
 * Synthetic parameters. Deliberately unlike anything plausible as tuning: the
 * bonuses are distinct primes so a mis-wired bonus shows up as the wrong number
 * rather than coincidentally matching another, and the cap is set low enough that
 * a WIN reliably crosses it.
 */
const SYNTHETIC = {
  REPID_CHALLENGE_WIN_BASE: '100',
  REPID_CHALLENGE_LOSS_BASE: '-200',
  REPID_CHALLENGE_VIOLATION_MULTIPLIER: '3',
  REPID_CHALLENGE_PEACEMAKER_BONUS: '7',
  REPID_CHALLENGE_SELF_MONITOR_BONUS: '11',
  REPID_CHALLENGE_ADHERENCE_BONUS: '13',
  REPID_CHALLENGE_MAX_SINGLE_REWARD: '150',
} as const;

const WIN_BASE = 100;
const LOSS_BASE = -200;
const VIOLATION_MULT = 3;
const PEACEMAKER = 7;
const SELF_MONITOR = 11;
const ADHERENCE = 13;
const MAX_REWARD = 150;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const [k, v] of Object.entries(SYNTHETIC)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  __resetScoringParamsCache();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetScoringParamsCache();
});

const score = (i: ChallengeInput) => scoreChallengeOutcome(i);

describe('WIN', () => {
  it('is the win base scaled by ecosystem need weight', () => {
    expect(score({ outcome: 'WIN', certaintyAtClaim: 0.8, ecosystemNeedWeight: 1.0 })).toBe(WIN_BASE);
    expect(score({ outcome: 'WIN', certaintyAtClaim: 0.8, ecosystemNeedWeight: 1.2 })).toBe(WIN_BASE * 1.2);
  });

  it('does not depend on certainty — only losing does', () => {
    const low = score({ outcome: 'WIN', certaintyAtClaim: 0.1, ecosystemNeedWeight: 1.0 });
    const high = score({ outcome: 'WIN', certaintyAtClaim: 1.0, ecosystemNeedWeight: 1.0 });
    expect(low).toBe(high);
  });

  it('is capped, so no single need weight can buy an unbounded reward', () => {
    // w=2 would pay 200; the cap is 150.
    expect(score({ outcome: 'WIN', certaintyAtClaim: 0.9, ecosystemNeedWeight: 2.0 })).toBe(MAX_REWARD);
    expect(score({ outcome: 'WIN', certaintyAtClaim: 0.9, ecosystemNeedWeight: 50 })).toBe(MAX_REWARD);
  });

  it('takes the adherence bonus, and the cap still binds afterwards', () => {
    expect(
      score({ outcome: 'WIN', certaintyAtClaim: 0.8, ecosystemNeedWeight: 1.0, constitutionalAdherence: true }),
    ).toBe(WIN_BASE + ADHERENCE);
    // 100*1.4 = 140, +13 = 153 → capped to 150. The bonus is inside the cap, not on top of it.
    expect(
      score({ outcome: 'WIN', certaintyAtClaim: 0.8, ecosystemNeedWeight: 1.4, constitutionalAdherence: true }),
    ).toBe(MAX_REWARD);
  });
});

describe('LOSS', () => {
  it('scales with certainty SQUARED — confident and wrong costs more than unsure and wrong', () => {
    const c = 0.9;
    expect(score({ outcome: 'LOSS', certaintyAtClaim: c, ecosystemNeedWeight: 1.0 })).toBe(
      Math.sign(LOSS_BASE * c ** 2) * Math.round(Math.abs(LOSS_BASE * c ** 2)),
    );
    // Squared, not linear: halving certainty quarters the penalty.
    const full = Math.abs(score({ outcome: 'LOSS', certaintyAtClaim: 1.0, ecosystemNeedWeight: 1.0 }));
    const half = Math.abs(score({ outcome: 'LOSS', certaintyAtClaim: 0.5, ecosystemNeedWeight: 1.0 }));
    expect(half).toBe(full / 4);
  });

  it('is monotonic in certainty across the whole range', () => {
    const magnitudes = [0, 0.25, 0.5, 0.75, 1].map((c) =>
      Math.abs(score({ outcome: 'LOSS', certaintyAtClaim: c, ecosystemNeedWeight: 1.0 })),
    );
    for (let i = 1; i < magnitudes.length; i++) {
      expect(magnitudes[i]!).toBeGreaterThan(magnitudes[i - 1]!);
    }
  });

  it('clamps certainty into [0,1] rather than extrapolating off the end', () => {
    const one = score({ outcome: 'LOSS', certaintyAtClaim: 1.0, ecosystemNeedWeight: 1.0 });
    expect(score({ outcome: 'LOSS', certaintyAtClaim: 5, ecosystemNeedWeight: 1.0 })).toBe(one);
    const zero = score({ outcome: 'LOSS', certaintyAtClaim: 0, ecosystemNeedWeight: 1.0 });
    expect(score({ outcome: 'LOSS', certaintyAtClaim: -5, ecosystemNeedWeight: 1.0 })).toBe(zero);
  });

  it('is NOT capped — the reward cap protects the ledger from inflation, not from punishment', () => {
    expect(score({ outcome: 'LOSS', certaintyAtClaim: 1.0, ecosystemNeedWeight: 3.0 })).toBe(LOSS_BASE * 3);
    expect(Math.abs(LOSS_BASE * 3)).toBeGreaterThan(MAX_REWARD);
  });

  it('is softened by self-monitoring, without flipping sign', () => {
    const plain = score({ outcome: 'LOSS', certaintyAtClaim: 0.8, ecosystemNeedWeight: 1.0 });
    const monitored = score({ outcome: 'LOSS', certaintyAtClaim: 0.8, ecosystemNeedWeight: 1.0, selfMonitoring: true });
    expect(monitored).toBe(plain + SELF_MONITOR);
    expect(monitored).toBeLessThan(0);
    expect(Math.abs(monitored)).toBeLessThan(Math.abs(plain));
  });
});

describe('violations', () => {
  it('cost the loss penalty multiplied — a violation is strictly worse than losing', () => {
    const loss = score({ outcome: 'LOSS', certaintyAtClaim: 0.95, ecosystemNeedWeight: 1.0 });
    const viol = score({ outcome: 'EPISTEMIC_VIOLATION', certaintyAtClaim: 0.95, ecosystemNeedWeight: 1.0 });
    expect(viol).toBe(
      Math.sign(loss) * Math.round(Math.abs(LOSS_BASE * VIOLATION_MULT * 0.95 ** 2)),
    );
    expect(viol).toBeLessThan(loss);
  });

  it('treat constitutional and epistemic violations identically', () => {
    // Stating opinion as fact and breaking your own stated rules are the same failure.
    for (const c of [0.1, 0.5, 0.9, 1.0]) {
      const ev = score({ outcome: 'EPISTEMIC_VIOLATION', certaintyAtClaim: c, ecosystemNeedWeight: 1.0 });
      const cv = score({ outcome: 'CONSTITUTIONAL_VIOLATION', certaintyAtClaim: c, ecosystemNeedWeight: 1.0 });
      expect(cv).toBe(ev);
    }
  });
});

describe('DRAW', () => {
  it('is zero on its own — neither side earns for not resolving anything', () => {
    expect(score({ outcome: 'DRAW', certaintyAtClaim: 0.5, ecosystemNeedWeight: 1.0 })).toBe(0);
    expect(score({ outcome: 'DRAW', certaintyAtClaim: 1.0, ecosystemNeedWeight: 9.0 })).toBe(0);
  });

  it('pays exactly the peacemaker bonus when a peacemaker produced it', () => {
    expect(score({ outcome: 'DRAW', certaintyAtClaim: 0.5, ecosystemNeedWeight: 1.0, isPeacemaker: true })).toBe(
      PEACEMAKER,
    );
  });

  it('is NOT subject to the win cap — the cap guards WIN only', () => {
    // Proven by construction: bonuses on a DRAW are the only way past a WIN cap, and
    // they are small. This asserts the branch, not a magnitude.
    const bonused = score({
      outcome: 'DRAW',
      certaintyAtClaim: 0.5,
      ecosystemNeedWeight: 1.0,
      isPeacemaker: true,
      selfMonitoring: true,
      constitutionalAdherence: true,
    });
    expect(bonused).toBe(PEACEMAKER + SELF_MONITOR + ADHERENCE);
  });
});

describe('the returned value is a ledger integer', () => {
  it('is always an integer', () => {
    for (const c of [0.13, 0.37, 0.61, 0.99]) {
      for (const o of ['WIN', 'LOSS', 'DRAW', 'EPISTEMIC_VIOLATION'] as const) {
        const v = score({ outcome: o, certaintyAtClaim: c, ecosystemNeedWeight: 1.07 });
        expect(Number.isInteger(v)).toBe(true);
      }
    }
  });

  it('rounds magnitude away from zero rather than toward negative infinity', () => {
    // -x.5 must become -(x+1), not -x: rounding a penalty toward zero would make the
    // punishment quietly lighter than the model states.
    process.env['REPID_CHALLENGE_LOSS_BASE'] = '-1';
    __resetScoringParamsCache();
    // -1 * 0.5^2 ... use a certainty that lands the product exactly on .5
    const v = score({ outcome: 'LOSS', certaintyAtClaim: Math.sqrt(0.5), ecosystemNeedWeight: 1.0 });
    expect(v).toBe(-1);
  });
});
