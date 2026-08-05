/**
 * scoring-params.test.ts
 *
 * The tuned RepID constants used to sit in four files that each carried the header
 * "do not expose constants in public repos" — in a public repo. They now come from
 * the environment.
 *
 * The properties that matter are the REFUSALS. A scoring service that starts with
 * the wrong numbers writes them into an append-only ledger other systems treat as
 * evidence; a service that refuses to start is a five-minute fix.
 */

import {
  loadScoringParams,
  REQUIRED_SCORING_ENV,
  isProduction,
} from '../src/config/scoring-params';

/** A complete, coherent production env. Values are arbitrary — that is the point. */
const FULL: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  REPID_DECAY_LAMBDA: '0.07', REPID_DECAY_K: '0.2',
  REPID_DECAY_FLOOR: '0.85', REPID_DECAY_CAP: '1.0',
  REPID_REDEMPTION_WINDOW_DAYS: '45', REPID_REDEMPTION_PROSOCIAL_THRESHOLD: '6',
  REPID_REDEMPTION_MODIFIER: '0.75',
  REPID_CHALLENGE_WIN_BASE: '30', REPID_CHALLENGE_LOSS_BASE: '-55',
  REPID_CHALLENGE_VIOLATION_MULTIPLIER: '1.6',
  REPID_CHALLENGE_PEACEMAKER_BONUS: '16', REPID_CHALLENGE_SELF_MONITOR_BONUS: '11',
  REPID_CHALLENGE_ADHERENCE_BONUS: '9', REPID_CHALLENGE_MAX_SINGLE_REWARD: '45',
  REPID_NEED_PHI_INV: '0.6', REPID_NEED_PHI_COMP: '0.4', REPID_NEED_EPSILON: '0.02',
  REPID_NEED_WEIGHT_FLOOR: '0.6', REPID_NEED_WEIGHT_CAP: '2.5',
  REPID_PREDICTION_BASE_REWARD: '18', REPID_PREDICTION_TAU_DAYS: '120',
};

describe('production refuses to start on missing parameters', () => {
  it('throws, and NAMES every missing variable', () => {
    const env = { ...FULL };
    delete env.REPID_DECAY_LAMBDA;
    delete env.REPID_NEED_WEIGHT_CAP;

    expect(() => loadScoringParams(env)).toThrow(/REFUSING TO START/);
    try { loadScoringParams(env); } catch (e) {
      const m = (e as Error).message;
      // Naming them is the difference between a five-minute fix and an afternoon.
      expect(m).toContain('REPID_DECAY_LAMBDA');
      expect(m).toContain('REPID_NEED_WEIGHT_CAP');
      expect(m).toContain('2 RepID scoring parameter');
    }
  });

  it('treats an empty string as missing, not as zero', () => {
    // '' coerces to 0 in JS — a decay lambda of 0 would silently disable decay.
    const env = { ...FULL, REPID_DECAY_LAMBDA: '   ' };
    expect(() => loadScoringParams(env)).toThrow(/REFUSING TO START/);
  });

  it('does NOT fall back to any committed default in production', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    expect(() => loadScoringParams(env)).toThrow(/REFUSING TO START/);
  });

  it('starts cleanly when every parameter is present', () => {
    const p = loadScoringParams(FULL);
    expect(p.decayLambda).toBe(0.07);
    expect(p.challengeLossBase).toBe(-55);
    expect(p.predictionTauDays).toBe(120);
  });
});

describe('out-of-range values are refused in EVERY environment', () => {
  it('rejects a non-numeric value', () => {
    expect(() => loadScoringParams({ ...FULL, REPID_DECAY_K: 'abc' }))
      .toThrow(/not a finite number/);
  });

  it('rejects a decay floor above 1', () => {
    expect(() => loadScoringParams({ ...FULL, REPID_DECAY_FLOOR: '1.5' }))
      .toThrow(/REPID_DECAY_FLOOR/);
  });

  it('rejects a POSITIVE challenge loss base — a penalty that rewards', () => {
    // The sign is the mechanism. A typo here inverts punishment into reward.
    expect(() => loadScoringParams({ ...FULL, REPID_CHALLENGE_LOSS_BASE: '55' }))
      .toThrow(/not a finite number within/);
  });

  it('rejects out-of-range even in dev — a typo must never become a live parameter', () => {
    const dev = { ...FULL, NODE_ENV: 'test', REPID_DECAY_LAMBDA: '99' };
    expect(() => loadScoringParams(dev)).toThrow(/REPID_DECAY_LAMBDA/);
  });
});

describe('structural coherence beyond per-value bounds', () => {
  it('refuses an inverted decay band (floor > cap)', () => {
    expect(() => loadScoringParams({ ...FULL, REPID_DECAY_FLOOR: '0.9', REPID_DECAY_CAP: '0.5' }))
      .toThrow(/decay would be inverted/);
  });

  it('refuses an inverted need-weight band', () => {
    expect(() => loadScoringParams({ ...FULL, REPID_NEED_WEIGHT_FLOOR: '3', REPID_NEED_WEIGHT_CAP: '1' }))
      .toThrow(/WEIGHT_FLOOR/);
  });
});

describe('non-production', () => {
  it('uses placeholders so a fresh clone and the test suite still run', () => {
    const p = loadScoringParams({ NODE_ENV: 'test' });
    expect(Number.isFinite(p.decayLambda)).toBe(true);
    expect(Number.isFinite(p.challengeWinBase)).toBe(true);
  });

  it('placeholders are NOT presented as the tuned values', () => {
    // Deliberately round/synthetic so nothing downstream treats them as calibration.
    const p = loadScoringParams({ NODE_ENV: 'test' });
    expect(p.decayFloor).toBe(0.5);
    expect(p.challengeWinBase).toBe(10);
  });

  it('an explicit env value still wins over the placeholder', () => {
    const p = loadScoringParams({ NODE_ENV: 'test', REPID_DECAY_LAMBDA: '0.42' });
    expect(p.decayLambda).toBe(0.42);
  });
});

describe('deploy checklist', () => {
  it('exports every required variable name, sorted', () => {
    expect(REQUIRED_SCORING_ENV.length).toBe(21);
    expect(REQUIRED_SCORING_ENV).toEqual([...REQUIRED_SCORING_ENV].sort());
    expect(REQUIRED_SCORING_ENV.every(v => v.startsWith('REPID_'))).toBe(true);
  });

  it('the checklist matches what production actually demands', () => {
    // Guards the drift where a new parameter is added but never listed for deploy.
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    try { loadScoringParams(env); } catch (e) {
      for (const v of REQUIRED_SCORING_ENV) expect((e as Error).message).toContain(v);
    }
  });

  it('isProduction only matches production', () => {
    expect(isProduction({ NODE_ENV: 'production' })).toBe(true);
    for (const v of ['test', 'development', '', undefined]) {
      expect(isProduction({ NODE_ENV: v as any })).toBe(false);
    }
  });
});
