import {
  birthRateMode,
  birthRateConfig,
  birthRateRatio,
  computeBirthRateDecision,
  checkBirthRate,
  BirthRateConfig,
} from '../src/services/birth-rate-breaker';

const CFG = (over: Partial<BirthRateConfig> = {}): BirthRateConfig => ({
  maxRatio: 2.0,
  windowMin: 15,
  minSample: 20,
  maxPending: 500,
  ...over,
});

describe('birthRateMode', () => {
  it('defaults to shadow when unset/blank/unknown', () => {
    expect(birthRateMode(undefined)).toBe('shadow');
    expect(birthRateMode('')).toBe('shadow');
    expect(birthRateMode('   ')).toBe('shadow');
    expect(birthRateMode('nonsense')).toBe('shadow');
  });
  it('parses off and enforce case/space-insensitively', () => {
    expect(birthRateMode('off')).toBe('off');
    expect(birthRateMode(' OFF ')).toBe('off');
    expect(birthRateMode('Enforce')).toBe('enforce');
  });
});

describe('birthRateConfig', () => {
  it('returns documented defaults when env unset', () => {
    expect(birthRateConfig({} as NodeJS.ProcessEnv)).toEqual({
      maxRatio: 2.0,
      windowMin: 15,
      minSample: 20,
      maxPending: 500,
    });
  });
  it('honors valid overrides', () => {
    const c = birthRateConfig({
      BIRTH_RATE_MAX_RATIO: '3.5',
      BIRTH_RATE_WINDOW_MIN: '30',
      BIRTH_RATE_MIN_SAMPLE: '5',
      BIRTH_RATE_MAX_PENDING: '1000',
    } as unknown as NodeJS.ProcessEnv);
    expect(c).toEqual({ maxRatio: 3.5, windowMin: 30, minSample: 5, maxPending: 1000 });
  });
  it('rejects out-of-range/garbage and falls back to defaults', () => {
    const c = birthRateConfig({
      BIRTH_RATE_MAX_RATIO: '0', // below floor (MIN_VALUE) → default
      BIRTH_RATE_WINDOW_MIN: '0', // below floor 1 → default
      BIRTH_RATE_MIN_SAMPLE: '-3', // below floor 0 → default
      BIRTH_RATE_MAX_PENDING: 'abc', // NaN → default
    } as unknown as NodeJS.ProcessEnv);
    expect(c).toEqual({ maxRatio: 2.0, windowMin: 15, minSample: 20, maxPending: 500 });
  });
  it('allows minSample of exactly 0 (floor is 0)', () => {
    expect(birthRateConfig({ BIRTH_RATE_MIN_SAMPLE: '0' } as unknown as NodeJS.ProcessEnv).minSample).toBe(0);
  });
});

describe('birthRateRatio', () => {
  it('divides normally', () => {
    expect(birthRateRatio(10, 5)).toBe(2);
  });
  it('is Infinity when completed=0 but pending>0', () => {
    expect(birthRateRatio(7, 0)).toBe(Infinity);
  });
  it('is 0 when both are 0', () => {
    expect(birthRateRatio(0, 0)).toBe(0);
  });
});

describe('computeBirthRateDecision', () => {
  it('mode=off never trips', () => {
    const d = computeBirthRateDecision({ pending: 100000, completed: 0, mode: 'off', config: CFG() });
    expect(d.exceeded).toBe(false);
    expect(d.halted).toBe(false);
    expect(d.reason).toBe('mode=off');
  });

  it('ratio breaker: exceeded when completed >= minSample and ratio > maxRatio', () => {
    const d = computeBirthRateDecision({ pending: 63, completed: 30, mode: 'enforce', config: CFG() });
    expect(d.ratio).toBeCloseTo(2.1);
    expect(d.exceeded).toBe(true);
    expect(d.halted).toBe(true);
  });

  it('ratio breaker: NOT exceeded at exactly the ratio (strictly greater required)', () => {
    const d = computeBirthRateDecision({ pending: 60, completed: 30, mode: 'enforce', config: CFG() });
    expect(d.ratio).toBe(2);
    expect(d.exceeded).toBe(false);
  });

  it('ratio breaker: suppressed below min sample even at a high ratio', () => {
    // pending 40, completed 5 → ratio 8, but completed < minSample(20) and pending < ceiling(500)
    const d = computeBirthRateDecision({ pending: 40, completed: 5, mode: 'enforce', config: CFG() });
    expect(d.ratio).toBe(8);
    expect(d.exceeded).toBe(false);
    expect(d.reason).toMatch(/below sample/);
  });

  it('ceiling breaker: fork-bomb (huge pending, 0 completed) trips despite no ratio signal', () => {
    const d = computeBirthRateDecision({ pending: 500, completed: 0, mode: 'enforce', config: CFG() });
    expect(d.exceeded).toBe(true);
    expect(d.halted).toBe(true);
    expect(d.reason).toMatch(/ceiling/);
  });

  it('healthy: below ratio and below ceiling → not exceeded', () => {
    const d = computeBirthRateDecision({ pending: 30, completed: 40, mode: 'enforce', config: CFG() });
    expect(d.exceeded).toBe(false);
    expect(d.reason).toMatch(/^ok:/);
  });

  it('shadow mode: exceeded true but halted false (measure, do not gate)', () => {
    const d = computeBirthRateDecision({ pending: 500, completed: 0, mode: 'shadow', config: CFG() });
    expect(d.exceeded).toBe(true);
    expect(d.halted).toBe(false);
  });
});

describe('checkBirthRate (DB counts, fail-open)', () => {
  // Build a minimal chainable stub whose terminal await resolves to {count,error}.
  function stubDb(pendingResult: any, completedResult: any) {
    let call = 0;
    const chain = (result: any) => {
      const p: any = {
        select: () => p,
        eq: () => p,
        in: () => p,
        gte: () => p,
        then: (resolve: any) => Promise.resolve(result).then(resolve),
      };
      return p;
    };
    return {
      from: () => {
        call += 1;
        return chain(call === 1 ? pendingResult : completedResult);
      },
    };
  }

  it('mode=off short-circuits without querying', async () => {
    let queried = false;
    const db = { from: () => { queried = true; return {} as any; } };
    const d = await checkBirthRate(db as any, 'peer_verify', { env: { BIRTH_RATE_BREAKER_MODE: 'off' } as any });
    expect(d.exceeded).toBe(false);
    expect(queried).toBe(false);
  });

  it('enforce: real counts over ratio → halted', async () => {
    const db = stubDb({ count: 100, error: null }, { count: 20, error: null });
    const d = await checkBirthRate(db as any, 'peer_verify', {
      env: { BIRTH_RATE_BREAKER_MODE: 'enforce' } as any,
      nowMs: 1_700_000_000_000,
    });
    expect(d.pending).toBe(100);
    expect(d.completed).toBe(20);
    expect(d.ratio).toBe(5);
    expect(d.halted).toBe(true);
  });

  it('fail-open: a count error yields exceeded=false and a fail-open reason', async () => {
    const db = stubDb({ count: null, error: { message: 'boom' } }, { count: 0, error: null });
    const d = await checkBirthRate(db as any, 'peer_verify', {
      env: { BIRTH_RATE_BREAKER_MODE: 'enforce' } as any,
    });
    expect(d.exceeded).toBe(false);
    expect(d.halted).toBe(false);
    expect(d.reason).toMatch(/fail-open/);
  });
});
