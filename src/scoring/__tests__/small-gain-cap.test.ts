/**
 * small-gain-cap.test.ts — proves the confirmed small-gain path is a CAP, not a ban, and
 * that every rule of Sean's scoring decision (strategy §v0.2.15) holds BY CONSTRUCTION.
 *
 * TUNING DISCIPLINE (house rule, tests/scoring-tuning-not-in-repo.test.ts): this suite PINS
 * its own parameters via env + the reset-cache seams. The numbers below are synthetic
 * test fixtures chosen only to satisfy the structural invariants — they are NOT the tuned
 * production magnitudes and must never be read as a reference for them. The module under
 * test is not one of the tuned-layer scorers the guard scans; it is pinned here regardless
 * because that is the correct pattern.
 */
import {
  capSmallGain,
  loadSmallGainCapParams,
  smallGainCapParams,
  smallGainScoringArmed,
  __resetSmallGainCapParamsCache,
  REQUIRED_SMALL_GAIN_ENV,
  type SmallGainDeps,
} from '../small-gain-cap';
import { __resetConfirmedParamsCache } from '../confirmed-outcome';

// ── pinned fixtures (synthetic; satisfy both lanes' invariants) ──────────────────────────
//
// Confirmed-outcome magnitudes my loader reads for the cross-lane invariants:
//   one small right (gainBase) = 4 ; one confirmed wrong (|lossBase|) = 50
// Small-gain caps measured against them:
//   prediction reference = 100  (> 10 x 4) ; ceiling fraction = 0.3
//   per-day cap = 24  (<= 0.3 x 100 = 30, and < 50) ; per-domain cap = 10 (<= 24)
const CONFIRMED_ENV: Record<string, string> = {
  REPID_CONFIRMED_GAIN_BASE: '4',
  REPID_CONFIRMED_LOSS_BASE: '-50',
  REPID_CONFIRMED_CONFIDENCE_LOSS_WEIGHT: '40',
  REPID_CONFIRMED_RUBBER_STAMP_PENALTY: '-100',
  REPID_CONFIRMED_BAND_TIGHTEN_BASE: '-8',
  REPID_CONFIRMED_SELF_REPORT_MISS_FACTOR: '0.5',
  REPID_CONFIRMED_NEED_WEIGHT_CAP: '2',
};
const SMALL_GAIN_ENV: Record<string, string> = {
  REPID_SMALL_GAIN_PER_DAY_CAP: '24',
  REPID_SMALL_GAIN_PER_DOMAIN_CAP: '10',
  REPID_SMALL_GAIN_PREDICTION_REFERENCE: '100',
  REPID_SMALL_GAIN_CEILING_FRACTION: '0.3',
};
const BASE_ENV: Record<string, string> = { ...CONFIRMED_ENV, ...SMALL_GAIN_ENV };

/** A full, valid env object for the direct (uncached) loader, with optional overrides. */
function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: Record<string, string | undefined> = { ...BASE_ENV, ...overrides };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e as NodeJS.ProcessEnv;
}

/** Budget readers that report a freshly-spent amount, always "checked". */
function deps(todaySpent = 0, domainSpent = 0): SmallGainDeps {
  return {
    accumulatedTodaySmallGain: async () => ({ checked: true, total: todaySpent }),
    accumulatedDomainSmallGain: async () => ({ checked: true, total: domainSpent }),
  };
}

const ALL_KEYS = [...Object.keys(BASE_ENV)];

/** Pin process.env for the cached accessors the resolver uses. */
function pinProcessEnv(overrides: Record<string, string | undefined> = {}): void {
  for (const k of ALL_KEYS) delete process.env[k];
  delete process.env['CONFIRMED_OUTCOME_SCORING_ENABLED'];
  const merged = { ...BASE_ENV, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetSmallGainCapParamsCache();
  __resetConfirmedParamsCache();
}

const SAVED = { ...process.env };
afterEach(() => {
  for (const k of [...ALL_KEYS, 'CONFIRMED_OUTCOME_SCORING_ENABLED']) delete process.env[k];
  for (const [k, v] of Object.entries(SAVED)) if (v !== undefined) process.env[k] = v;
  __resetSmallGainCapParamsCache();
  __resetConfirmedParamsCache();
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('STRUCTURAL: the load-time invariants encode the decision (cap, not ban)', () => {
  it('a coherent env loads, and REQUIRED_SMALL_GAIN_ENV names all four magnitudes', () => {
    const p = loadSmallGainCapParams(env());
    expect(p.perDayCap).toBe(24);
    expect(p.perDomainCap).toBe(10);
    expect(p.predictionReferenceGain).toBe(100);
    expect(p.ceilingFractionOfPrediction).toBe(0.3);
    expect(REQUIRED_SMALL_GAIN_ENV).toEqual([
      'REPID_SMALL_GAIN_CEILING_FRACTION',
      'REPID_SMALL_GAIN_PER_DAY_CAP',
      'REPID_SMALL_GAIN_PER_DOMAIN_CAP',
      'REPID_SMALL_GAIN_PREDICTION_REFERENCE',
    ]);
  });

  it('a zero cap is a BAN, and is refused (the decision is a cap, not a ban)', () => {
    expect(() => loadSmallGainCapParams(env({ REPID_SMALL_GAIN_PER_DAY_CAP: '0' }))).toThrow(/cap, not a ban/);
    expect(() => loadSmallGainCapParams(env({ REPID_SMALL_GAIN_PER_DOMAIN_CAP: '0' }))).toThrow(/cap, not a ban/);
  });

  it('a per-domain cap above the per-day cap is refused (one domain <= a whole day)', () => {
    expect(() =>
      loadSmallGainCapParams(env({ REPID_SMALL_GAIN_PER_DOMAIN_CAP: '25' })),
    ).toThrow(/one domain cannot earn more than a whole day/);
  });

  it('the ceiling fraction must be strictly in (0,1)', () => {
    expect(() => loadSmallGainCapParams(env({ REPID_SMALL_GAIN_CEILING_FRACTION: '1' }))).toThrow(/strictly between 0 and 1|within \[0, 1\]/);
    expect(() => loadSmallGainCapParams(env({ REPID_SMALL_GAIN_CEILING_FRACTION: '0' }))).toThrow(/strictly between 0 and 1/);
  });

  it('TEN SMALL RIGHTS < ONE PREDICTED RIGHT — a too-small prediction reference is refused', () => {
    // 10 x gainBase(4) = 40; a reference of 40 or below must be rejected.
    expect(() =>
      loadSmallGainCapParams(env({ REPID_SMALL_GAIN_PREDICTION_REFERENCE: '40' })),
    ).toThrow(/ten small rights must not outweigh one predicted right/);
  });

  it('CAPPED BELOW A FRACTION OF ONE PREDICTION — a per-day cap above ceiling x reference is refused', () => {
    // ceiling 0.3 x reference 100 = 30; a per-day cap of 31 exceeds it.
    expect(() =>
      loadSmallGainCapParams(env({ REPID_SMALL_GAIN_PER_DAY_CAP: '31', REPID_SMALL_GAIN_PER_DOMAIN_CAP: '10' })),
    ).toThrow(/below a fraction of one confirmed pre-committed prediction/);
  });

  it('CANNOT OUTRUN A CONFIRMED WRONG — a per-day cap at/above |one wrong| is refused', () => {
    // |lossBase| = 50. A per-day cap of 50 (within the ceiling only if reference is larger) must
    // still be refused by the cannot-outrun-a-wrong invariant. Raise the reference/ceiling so the
    // ONLY failing invariant is the confirmed-wrong one.
    expect(() =>
      loadSmallGainCapParams(
        env({
          REPID_SMALL_GAIN_PER_DAY_CAP: '50',
          REPID_SMALL_GAIN_PREDICTION_REFERENCE: '1000',
          REPID_SMALL_GAIN_CEILING_FRACTION: '0.9',
        }),
      ),
    ).toThrow(/cannot outrun a single confirmed wrong/);
  });

  it('an out-of-range raw magnitude is refused in every environment', () => {
    expect(() => loadSmallGainCapParams(env({ REPID_SMALL_GAIN_PER_DAY_CAP: '-5' }))).toThrow(/within \[0, 10000\]/);
    expect(() => loadSmallGainCapParams(env({ REPID_SMALL_GAIN_CEILING_FRACTION: '2' }))).toThrow(/within \[0, 1\]/);
  });

  it('a day of capped small gains cannot reach one prediction (the decision, made legible)', () => {
    const p = loadSmallGainCapParams(env());
    // The MOST a day of small rights can total is perDayCap, and that is strictly below one
    // prediction — and below one confirmed wrong.
    expect(p.perDayCap).toBeLessThan(p.predictionReferenceGain);
    expect(p.perDayCap).toBeLessThanOrEqual(p.ceilingFractionOfPrediction * p.predictionReferenceGain);
    expect(p.perDayCap).toBeLessThan(50); // |one confirmed wrong|
    expect(p.perDomainCap).toBeLessThanOrEqual(p.perDayCap);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the after-the-fact self-rating path is CLOSED, forever', () => {
  beforeEach(() => pinProcessEnv({ CONFIRMED_OUTCOME_SCORING_ENABLED: 'true' }));

  it('a self-rating earns zero even armed, with a full budget and a positive gain', async () => {
    const r = await capSmallGain(
      { actorAgentId: 'a1', domain: 'math', computedGain: 4, afterTheFactSelfRating: true },
      deps(0, 0),
    );
    expect(r.cappedGain).toBe(0);
    expect(r.wouldMoveScore).toBe(false);
    expect(r.reason).toBe('self_rating_closed');
    expect(r.detail.afterTheFactSelfRating).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('DOMAIN ISOLATION: a gain with no domain cannot cross domains, so it earns nothing', () => {
  beforeEach(() => pinProcessEnv({ CONFIRMED_OUTCOME_SCORING_ENABLED: 'true' }));

  it('a null domain earns zero', async () => {
    const r = await capSmallGain({ actorAgentId: 'a1', domain: null, computedGain: 4 }, deps(0, 0));
    expect(r.cappedGain).toBe(0);
    expect(r.reason).toBe('no_domain_no_gain');
  });

  it('an empty / whitespace domain earns zero', async () => {
    const r = await capSmallGain({ actorAgentId: 'a1', domain: '   ', computedGain: 4 }, deps(0, 0));
    expect(r.cappedGain).toBe(0);
    expect(r.reason).toBe('no_domain_no_gain');
  });

  it('the per-domain budget is keyed by domain (domains do not share a budget)', async () => {
    const seen: string[] = [];
    const d: SmallGainDeps = {
      accumulatedTodaySmallGain: async () => ({ checked: true, total: 0 }),
      accumulatedDomainSmallGain: async (_id, domain) => {
        seen.push(domain);
        return { checked: true, total: domain === 'math' ? 9 : 0 };
      },
    };
    const math = await capSmallGain({ actorAgentId: 'a1', domain: 'math', computedGain: 4 }, d);
    const code = await capSmallGain({ actorAgentId: 'a1', domain: 'code', computedGain: 4 }, d);
    expect(seen).toEqual(['math', 'code']);
    expect(math.cappedGain).toBe(1); // math nearly exhausted (9/10)
    expect(code.cappedGain).toBe(4); // code untouched — no spillover from math
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('only a positive confirmed gain is capped here', () => {
  beforeEach(() => pinProcessEnv({ CONFIRMED_OUTCOME_SCORING_ENABLED: 'true' }));

  it('a zero or negative computed gain passes through as zero (losses are not this lane)', async () => {
    for (const g of [0, -7, Number.NaN]) {
      const r = await capSmallGain({ actorAgentId: 'a1', domain: 'math', computedGain: g }, deps(0, 0));
      expect(r.cappedGain).toBe(0);
      expect(r.reason).toBe('no_positive_gain');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('FAIL CLOSED: an unreadable budget is never a free budget', () => {
  beforeEach(() => pinProcessEnv({ CONFIRMED_OUTCOME_SCORING_ENABLED: 'true' }));

  it('no per-day reader ⇒ zero, day_budget_unreadable', async () => {
    const r = await capSmallGain({ actorAgentId: 'a1', domain: 'math', computedGain: 4 }, {
      accumulatedDomainSmallGain: async () => ({ checked: true, total: 0 }),
    });
    expect(r.cappedGain).toBe(0);
    expect(r.reason).toBe('day_budget_unreadable');
  });

  it('per-day checked:false ⇒ zero, day_budget_unreadable', async () => {
    const r = await capSmallGain({ actorAgentId: 'a1', domain: 'math', computedGain: 4 }, {
      accumulatedTodaySmallGain: async () => ({ checked: false, total: 0 }),
      accumulatedDomainSmallGain: async () => ({ checked: true, total: 0 }),
    });
    expect(r.cappedGain).toBe(0);
    expect(r.reason).toBe('day_budget_unreadable');
  });

  it('no per-domain reader ⇒ zero, domain_budget_unreadable', async () => {
    const r = await capSmallGain({ actorAgentId: 'a1', domain: 'math', computedGain: 4 }, {
      accumulatedTodaySmallGain: async () => ({ checked: true, total: 0 }),
    });
    expect(r.cappedGain).toBe(0);
    expect(r.reason).toBe('domain_budget_unreadable');
  });

  it('per-domain checked:false ⇒ zero, domain_budget_unreadable', async () => {
    const r = await capSmallGain({ actorAgentId: 'a1', domain: 'math', computedGain: 4 }, {
      accumulatedTodaySmallGain: async () => ({ checked: true, total: 0 }),
      accumulatedDomainSmallGain: async () => ({ checked: false, total: 0 }),
    });
    expect(r.cappedGain).toBe(0);
    expect(r.reason).toBe('domain_budget_unreadable');
  });

  it('a reader that throws ⇒ zero, resolver_error — never a throw into the score path', async () => {
    const r = await capSmallGain({ actorAgentId: 'a1', domain: 'math', computedGain: 4 }, {
      accumulatedTodaySmallGain: async () => {
        throw new Error('db down');
      },
      accumulatedDomainSmallGain: async () => ({ checked: true, total: 0 }),
    });
    expect(r.cappedGain).toBe(0);
    expect(r.reason).toBe('resolver_error');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('the caps bind (per-day and per-domain)', () => {
  beforeEach(() => pinProcessEnv({ CONFIRMED_OUTCOME_SCORING_ENABLED: 'true' }));

  it('within both budgets ⇒ the full computed gain, within_caps', async () => {
    const r = await capSmallGain({ actorAgentId: 'a1', domain: 'math', computedGain: 3 }, deps(0, 0));
    expect(r.cappedGain).toBe(3);
    expect(r.reason).toBe('within_caps');
    expect(r.detail.perDayRemaining).toBe(24);
    expect(r.detail.perDomainRemaining).toBe(10);
  });

  it('the per-day budget binds when it is the tighter cap', async () => {
    // day spent 22 ⇒ 2 remaining; domain fresh ⇒ 10 remaining; gain 5 ⇒ capped to 2.
    const r = await capSmallGain({ actorAgentId: 'a1', domain: 'math', computedGain: 5 }, deps(22, 0));
    expect(r.cappedGain).toBe(2);
    expect(r.reason).toBe('capped_by_budget');
  });

  it('the per-domain budget binds when it is the tighter cap', async () => {
    // domain spent 9 ⇒ 1 remaining; day fresh ⇒ 24 remaining; gain 5 ⇒ capped to 1.
    const r = await capSmallGain({ actorAgentId: 'a1', domain: 'math', computedGain: 5 }, deps(0, 9));
    expect(r.cappedGain).toBe(1);
    expect(r.reason).toBe('capped_by_budget');
  });

  it('an exhausted budget ⇒ zero, capped_to_zero_budget_exhausted', async () => {
    const r = await capSmallGain({ actorAgentId: 'a1', domain: 'math', computedGain: 5 }, deps(24, 0));
    expect(r.cappedGain).toBe(0);
    expect(r.reason).toBe('capped_to_zero_budget_exhausted');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
describe('SHADOW while the flag is OFF (recorded, never moved); armed only with the flag ON', () => {
  it('flag unset ⇒ not armed; a positive cap is computed but would NOT move the score', async () => {
    pinProcessEnv(); // no CONFIRMED_OUTCOME_SCORING_ENABLED
    expect(smallGainScoringArmed()).toBe(false);
    const r = await capSmallGain({ actorAgentId: 'a1', domain: 'math', computedGain: 3 }, deps(0, 0));
    expect(r.cappedGain).toBe(3); // the decision is still computed and recordable
    expect(r.armed).toBe(false);
    expect(r.wouldMoveScore).toBe(false); // shadow: recorded, not moved
    expect(r.reason).toBe('within_caps');
  });

  it("flag 'true' ⇒ armed; the same positive cap WOULD move the score", async () => {
    pinProcessEnv({ CONFIRMED_OUTCOME_SCORING_ENABLED: 'true' });
    expect(smallGainScoringArmed()).toBe(true);
    const r = await capSmallGain({ actorAgentId: 'a1', domain: 'math', computedGain: 3 }, deps(0, 0));
    expect(r.cappedGain).toBe(3);
    expect(r.armed).toBe(true);
    expect(r.wouldMoveScore).toBe(true);
  });

  it('the cached accessor resolves the pinned params', () => {
    pinProcessEnv();
    expect(smallGainCapParams().perDayCap).toBe(24);
  });
});
