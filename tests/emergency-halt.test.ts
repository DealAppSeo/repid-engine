/**
 * L0 gate 0.4 — global emergency halt (kill switch).
 *
 * What these tests are actually defending, in priority order:
 *  1. Default behaviour is UNCHANGED (flag false → nothing parks, nothing 503s).
 *  2. When pulled, the switch actually works — including via a mode value the
 *     operator typo'd, and including a stringified column value.
 *  3. A DB error can never START a halt, and can never LIFT one.
 *  4. The switch is INERT and silent-safe before the DDL lands.
 */

import {
  __resetEmergencyHaltState,
  __stopEmergencyHaltRefresher,
  checkEmergencyHalt,
  isHaltTruthy,
  peekHaltState,
  resolveHaltMode,
  shouldParkForHalt,
  startEmergencyHaltRefresher,
} from '../src/services/emergency-halt';
import {
  __resetEmergencyHaltMiddlewareState,
  emergencyHaltMiddleware,
} from '../src/middleware/emergency-halt';

/** Minimal stand-in for the supabase query chain this module uses. */
function fakeClient(result: { data?: any; error?: any } | (() => { data?: any; error?: any })) {
  const calls = { from: 0 };
  const client = {
    from(table: string) {
      calls.from += 1;
      expect(table).toBe('trinity_system_config');
      return {
        select: (_cols: string) => ({
          eq: (_col: string, _val: unknown) => ({
            maybeSingle: async () => (typeof result === 'function' ? result() : result),
          }),
        }),
      };
    },
  };
  return { client: client as any, calls };
}

/** A client whose query chain throws rather than returning an error object. */
function throwingClient(message: string) {
  return {
    from() {
      throw new Error(message);
    },
  } as any;
}

let warnSpy: jest.SpyInstance;
let errorSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;

beforeEach(() => {
  __resetEmergencyHaltState();
  __stopEmergencyHaltRefresher();
  __resetEmergencyHaltMiddlewareState();
  delete process.env.EMERGENCY_HALT_MODE;
  delete process.env.EMERGENCY_HALT_CACHE_MS;
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  logSpy.mockRestore();
});

// ---------------------------------------------------------------- mode parsing

describe('resolveHaltMode — fail-CLOSED, unlike every other mode parser here', () => {
  it.each([
    [undefined, 'enforce'],
    [null, 'enforce'],
    ['', 'enforce'],
    ['enforce', 'enforce'],
    ['off', 'off'],
    ['OFF', 'off'],
    ['  off  ', 'off'],
    ['shadow', 'shadow'],
    ['SHADOW', 'shadow'],
  ])('%p → %s', (raw, expected) => {
    expect(resolveHaltMode(raw as any)).toBe(expected);
  });

  // The whole point: a near-miss must NOT disable the kill switch.
  it.each(['of', 'offf', 'false', '0', 'no', 'disabled', 'null', 'enfroce', 'ENFORCE!', 'shadwo'])(
    'near-miss %p resolves to enforce, not off',
    (raw) => {
      expect(resolveHaltMode(raw)).toBe('enforce');
    },
  );

  it('warns exactly once for an unrecognized value, not once per call', () => {
    resolveHaltMode('of');
    resolveHaltMode('of');
    resolveHaltMode('nonsense');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('EMERGENCY_HALT_MODE');
  });

  it('does not warn for the recognized values', () => {
    resolveHaltMode('off');
    resolveHaltMode('shadow');
    resolveHaltMode('enforce');
    resolveHaltMode(undefined);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('isHaltTruthy — only a deliberate true halts', () => {
  it.each([[true], ['true'], ['TRUE'], ['  true  ']])('%p is a pulled switch', (v) => {
    expect(isHaltTruthy(v)).toBe(true);
  });

  it.each([[false], ['false'], [null], [undefined], [0], [1], ['1'], ['yes'], ['TRUE!'], [{}], [[]]])(
    '%p is not',
    (v) => {
      expect(isHaltTruthy(v)).toBe(false);
    },
  );
});

// -------------------------------------------------------------- the happy path

describe('checkEmergencyHalt — default behaviour is unchanged', () => {
  it('flag false → not halted, and the caller sees source=db', async () => {
    const { client } = fakeClient({ data: { emergency_halt: false }, error: null });
    const d = await checkEmergencyHalt(client, { mode: 'enforce' });
    expect(d).toMatchObject({ flag: false, halted: false, mode: 'enforce', source: 'db' });
  });

  it('a missing config row reads as not-halted and says so', async () => {
    const { client } = fakeClient({ data: null, error: null });
    const d = await checkEmergencyHalt(client, { mode: 'enforce' });
    expect(d.flag).toBe(false);
    expect(d.halted).toBe(false);
    expect(d.reason).toContain('no config row');
  });
});

describe('checkEmergencyHalt — when pulled, it works', () => {
  it('flag true + enforce → halted', async () => {
    const { client } = fakeClient({ data: { emergency_halt: true }, error: null });
    const d = await checkEmergencyHalt(client, { mode: 'enforce' });
    expect(d.flag).toBe(true);
    expect(d.halted).toBe(true);
  });

  it('flag true + shadow → flagged but NOT halted', async () => {
    const { client } = fakeClient({ data: { emergency_halt: true }, error: null });
    const d = await checkEmergencyHalt(client, { mode: 'shadow' });
    expect(d.flag).toBe(true);
    expect(d.halted).toBe(false);
  });

  it('a stringified "true" still halts', async () => {
    const { client } = fakeClient({ data: { emergency_halt: 'true' }, error: null });
    expect((await checkEmergencyHalt(client, { mode: 'enforce' })).halted).toBe(true);
  });

  it('resolves the mode from the environment when not passed explicitly', async () => {
    process.env.EMERGENCY_HALT_MODE = 'shadow';
    const { client } = fakeClient({ data: { emergency_halt: true }, error: null });
    const d = await checkEmergencyHalt(client);
    expect(d.mode).toBe('shadow');
    expect(d.halted).toBe(false);
  });

  it('a typo in EMERGENCY_HALT_MODE still enforces — the switch cannot be typo-disabled', async () => {
    process.env.EMERGENCY_HALT_MODE = 'of';
    const { client } = fakeClient({ data: { emergency_halt: true }, error: null });
    const d = await checkEmergencyHalt(client);
    expect(d.mode).toBe('enforce');
    expect(d.halted).toBe(true);
  });

  // Regression pin: the first cut of this log line printed "Workers park,
  // mutating HTTP returns 503" in BOTH modes, so shadow mode announced a
  // consequence it was not having. An operator reading that during an incident
  // concludes the fleet is parked when it is running.
  it('the shadow-mode log does NOT claim anything was parked or refused', async () => {
    const { client } = fakeClient({ data: { emergency_halt: true }, error: null });
    await checkEmergencyHalt(client, { mode: 'shadow' });
    const msg = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('NOT ENFORCED');
    expect(msg).not.toContain('Workers park');
    expect(msg).not.toContain('returns 503');
  });

  it('logs the halt loudly with the rollback statement in the message', async () => {
    const { client } = fakeClient({ data: { emergency_halt: true }, error: null });
    await checkEmergencyHalt(client, { mode: 'enforce' });
    const msg = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msg).toContain('GLOBAL HALT ACTIVE');
    expect(msg).toContain('emergency_halt=false');
  });
});

describe('EMERGENCY_HALT_MODE=off — the escape hatch costs nothing', () => {
  it('never touches the database', async () => {
    const { client, calls } = fakeClient({ data: { emergency_halt: true }, error: null });
    const d = await checkEmergencyHalt(client, { mode: 'off' });
    expect(calls.from).toBe(0);
    expect(d.source).toBe('disabled');
    expect(d.halted).toBe(false);
    // ...even though the flag in the DB is true. off means off.
    expect(d.flag).toBe(false);
  });
});

// -------------------------------------------------------------------- caching

describe('caching — one read per TTL, and a failure never extends a stale value', () => {
  it('a second call inside the TTL does not re-read', async () => {
    const { client, calls } = fakeClient({ data: { emergency_halt: false }, error: null });
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 5000, now: 1_000 });
    const second = await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 5000, now: 3_000 });
    expect(calls.from).toBe(1);
    expect(second.source).toBe('cache');
  });

  it('a call past the TTL re-reads and sees the new value', async () => {
    let flag = false;
    const { client, calls } = fakeClient(() => ({ data: { emergency_halt: flag }, error: null }));
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 5000, now: 1_000 });
    flag = true;
    const later = await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 5000, now: 7_000 });
    expect(calls.from).toBe(2);
    expect(later.halted).toBe(true);
    expect(later.source).toBe('db');
  });

  it('cacheMs=0 disables caching entirely', async () => {
    const { client, calls } = fakeClient({ data: { emergency_halt: false }, error: null });
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 1_000 });
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 1_000 });
    expect(calls.from).toBe(2);
  });

  it('a garbage EMERGENCY_HALT_CACHE_MS falls back to the default rather than NaN', async () => {
    process.env.EMERGENCY_HALT_CACHE_MS = 'soon';
    const { client, calls } = fakeClient({ data: { emergency_halt: false }, error: null });
    const t = Date.now();
    await checkEmergencyHalt(client, { mode: 'enforce', now: t });
    await checkEmergencyHalt(client, { mode: 'enforce', now: t + 100 });
    // NaN comparisons are always false, so a NaN TTL would have re-read here.
    expect(calls.from).toBe(1);
  });
});

// --------------------------------------------------------- failure semantics

describe('failure semantics — an error can never start a halt', () => {
  it('an error with no prior successful read fails OPEN', async () => {
    const { client } = fakeClient({ data: null, error: { code: '08006', message: 'connection reset' } });
    const d = await checkEmergencyHalt(client, { mode: 'enforce' });
    expect(d.halted).toBe(false);
    expect(d.source).toBe('error_open');
  });

  it('a thrown exception fails OPEN rather than propagating', async () => {
    const d = await checkEmergencyHalt(throwingClient('socket hang up'), { mode: 'enforce' });
    expect(d.halted).toBe(false);
    expect(d.source).toBe('error_open');
    expect(d.reason).toContain('socket hang up');
  });

  it('an error after a successful read of FALSE still fails open', async () => {
    let mode: 'ok' | 'boom' = 'ok';
    const { client } = fakeClient(() =>
      mode === 'ok'
        ? { data: { emergency_halt: false }, error: null }
        : { data: null, error: { code: '08006', message: 'gone' } },
    );
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 1 });
    mode = 'boom';
    const d = await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 2 });
    expect(d.halted).toBe(false);
    expect(d.source).toBe('error_open');
  });
});

describe('failure semantics — an error can never LIFT a halt (sticky)', () => {
  it('stays halted when the read fails after a successful read of TRUE', async () => {
    let mode: 'ok' | 'boom' = 'ok';
    const { client } = fakeClient(() =>
      mode === 'ok'
        ? { data: { emergency_halt: true }, error: null }
        : { data: null, error: { code: '08006', message: 'gone' } },
    );
    const first = await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 1 });
    expect(first.halted).toBe(true);

    mode = 'boom';
    const second = await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 2 });
    expect(second.flag).toBe(true);
    expect(second.halted).toBe(true);
    expect(second.source).toBe('error_sticky');
  });

  it('only a successful read of false resumes', async () => {
    let phase: 'halted' | 'boom' | 'clear' = 'halted';
    const { client } = fakeClient(() => {
      if (phase === 'halted') return { data: { emergency_halt: true }, error: null };
      if (phase === 'boom') return { data: null, error: { code: '08006', message: 'gone' } };
      return { data: { emergency_halt: false }, error: null };
    });
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 1 });
    phase = 'boom';
    expect((await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 2 })).halted).toBe(true);
    phase = 'clear';
    const resumed = await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 3 });
    expect(resumed.halted).toBe(false);
    expect(resumed.source).toBe('db');
  });

  it('a sticky halt is reported on stderr, not swallowed', async () => {
    let mode: 'ok' | 'boom' = 'ok';
    const { client } = fakeClient(() =>
      mode === 'ok' ? { data: { emergency_halt: true }, error: null } : { data: null, error: { message: 'gone' } },
    );
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 1 });
    mode = 'boom';
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 2 });
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('sticky');
  });
});

describe('timeout — the check can never wedge the system it protects', () => {
  /** A client whose read never settles, the way a hung connection behaves. */
  function hangingClient() {
    const calls = { from: 0 };
    const client = {
      from() {
        calls.from += 1;
        return {
          select: () => ({
            eq: () => ({ maybeSingle: () => new Promise(() => {}) }),
          }),
        };
      },
    };
    return { client: client as any, calls };
  }

  // This is the regression test for the defect CI caught: without a bound, a
  // POST through the app hung to jest's 5s timeout, and in production a slow
  // database would have stalled every write.
  it('a read that never settles fails open within the timeout', async () => {
    const { client } = hangingClient();
    const started = Date.now();
    const d = await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(d.halted).toBe(false);
    expect(d.source).toBe('error_open');
    expect(d.reason).toContain('timed out');
  });

  it('a timeout does not lift an existing halt', async () => {
    let phase: 'halted' | 'hang' = 'halted';
    const client = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              phase === 'halted'
                ? Promise.resolve({ data: { emergency_halt: true }, error: null })
                : new Promise(() => {}),
          }),
        }),
      }),
    } as any;
    expect((await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 1, timeoutMs: 50 })).halted).toBe(true);
    phase = 'hang';
    const d = await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 2, timeoutMs: 50 });
    expect(d.halted).toBe(true);
    expect(d.source).toBe('error_sticky');
  });

  it('an outage costs one timeout per interval, not one per caller', async () => {
    const { client, calls } = hangingClient();
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 5000, now: 1_000, timeoutMs: 30 });
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 5000, now: 1_100, timeoutMs: 30 });
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 5000, now: 1_200, timeoutMs: 30 });
    expect(calls.from).toBe(1);
  });

  it('the backoff expires so a recovered database is noticed', async () => {
    let broken = true;
    const { client } = fakeClient(() =>
      broken ? { data: null, error: { code: '08006', message: 'gone' } } : { data: { emergency_halt: true }, error: null },
    );
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 5000, now: 1_000 });
    broken = false;
    // still inside the backoff window — not retried
    expect((await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 5000, now: 2_000 })).source).toBe('error_open');
    // past it — retried, and the real value comes through
    const recovered = await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 5000, now: 7_000 });
    expect(recovered.source).toBe('db');
    expect(recovered.halted).toBe(true);
  });

  it('a successful read clears the backoff immediately', async () => {
    let broken = true;
    const { client, calls } = fakeClient(() =>
      broken ? { data: null, error: { message: 'gone' } } : { data: { emergency_halt: false }, error: null },
    );
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 1_000 });
    broken = false;
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 9_000 });
    expect(calls.from).toBe(2);
    // with cacheMs=0 the next call must reach the DB again, not a stale backoff
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 9_001 });
    expect(calls.from).toBe(3);
  });

  it('a garbage EMERGENCY_HALT_TIMEOUT_MS falls back to the default rather than 0 or NaN', async () => {
    process.env.EMERGENCY_HALT_TIMEOUT_MS = 'quickly';
    const { client } = fakeClient({ data: { emergency_halt: true }, error: null });
    // a 0 or NaN timeout would abort the read instantly and fail open
    const d = await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0 });
    expect(d.source).toBe('db');
    expect(d.halted).toBe(true);
    delete process.env.EMERGENCY_HALT_TIMEOUT_MS;
  });
});

describe('the DDL has not landed yet — the switch is inert, not broken', () => {
  it.each([
    ['42703', 'column trinity_system_config.emergency_halt does not exist'],
    ['PGRST204', "Could not find the 'emergency_halt' column"],
  ])('code %s is recognized as a missing column', async (code, message) => {
    const { client } = fakeClient({ data: null, error: { code, message } });
    const d = await checkEmergencyHalt(client, { mode: 'enforce' });
    expect(d.source).toBe('column_absent');
    expect(d.halted).toBe(false);
  });

  it('recognizes a missing column from the message alone when no code is supplied', async () => {
    const { client } = fakeClient({
      data: null,
      error: { message: 'column "emergency_halt" does not exist' },
    });
    expect((await checkEmergencyHalt(client, { mode: 'enforce' })).source).toBe('column_absent');
  });

  it('warns once about the inert switch, not once per tick', async () => {
    const { client } = fakeClient({ data: null, error: { code: '42703', message: 'nope' } });
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 1 });
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 2 });
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0, now: 3 });
    const inertWarnings = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('INERT'));
    expect(inertWarnings).toHaveLength(1);
  });

  it('an UNRELATED error is not mistaken for a missing column', async () => {
    const { client } = fakeClient({
      data: null,
      error: { code: '42501', message: 'permission denied for table trinity_system_config' },
    });
    expect((await checkEmergencyHalt(client, { mode: 'enforce' })).source).toBe('error_open');
  });
});

// ------------------------------------------------------------ the tick helper

describe('shouldParkForHalt — the identical three-line guard every worker uses', () => {
  it('returns true and names the worker when halted', async () => {
    const { client } = fakeClient({ data: { emergency_halt: true }, error: null });
    expect(await shouldParkForHalt(client, 'TrinityTaskBridge')).toBe(true);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('[TrinityTaskBridge]');
  });

  it('returns false in shadow mode but still narrates that it WOULD park', async () => {
    process.env.EMERGENCY_HALT_MODE = 'shadow';
    const { client } = fakeClient({ data: { emergency_halt: true }, error: null });
    expect(await shouldParkForHalt(client, 'ValidationWorker')).toBe(false);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('WOULD park');
  });

  it('returns false and says nothing on the normal path', async () => {
    const { client } = fakeClient({ data: { emergency_halt: false }, error: null });
    expect(await shouldParkForHalt(client, 'PeerVerificationReader')).toBe(false);
    const noise = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('PeerVerificationReader'));
    expect(noise).toHaveLength(0);
  });
});

// -------------------------------------------------- peek + background refresher

describe('peekHaltState — synchronous, never queries', () => {
  it('reports uninitialized before anything has been read', () => {
    const s = peekHaltState();
    expect(s.initialized).toBe(false);
    expect(s.halted).toBe(false);
  });

  it('reflects the last successful read', async () => {
    const { client } = fakeClient({ data: { emergency_halt: true }, error: null });
    await checkEmergencyHalt(client, { mode: 'enforce', cacheMs: 0 });
    const s = peekHaltState();
    expect(s.initialized).toBe(true);
    expect(s.halted).toBe(true);
  });

  it('does not report halted in shadow mode', async () => {
    const { client } = fakeClient({ data: { emergency_halt: true }, error: null });
    await checkEmergencyHalt(client, { mode: 'shadow', cacheMs: 0 });
    process.env.EMERGENCY_HALT_MODE = 'shadow';
    expect(peekHaltState().halted).toBe(false);
  });

  it('reports not-halted and initialized when the mode is off', () => {
    process.env.EMERGENCY_HALT_MODE = 'off';
    expect(peekHaltState()).toMatchObject({ halted: false, initialized: true, mode: 'off' });
  });
});

describe('startEmergencyHaltRefresher — one query per interval for the whole process', () => {
  afterEach(() => __stopEmergencyHaltRefresher());

  it('primes the state immediately rather than after one interval', async () => {
    const { client, calls } = fakeClient({ data: { emergency_halt: true }, error: null });
    startEmergencyHaltRefresher(client, 60_000);
    await new Promise((r) => setImmediate(r));
    expect(calls.from).toBe(1);
    expect(peekHaltState()).toMatchObject({ initialized: true, halted: true });
  });

  it('is idempotent — a second start does not add a second poller', async () => {
    const { client, calls } = fakeClient({ data: { emergency_halt: false }, error: null });
    startEmergencyHaltRefresher(client, 60_000);
    startEmergencyHaltRefresher(client, 60_000);
    startEmergencyHaltRefresher(client, 60_000);
    await new Promise((r) => setImmediate(r));
    expect(calls.from).toBe(1);
  });
});

// ------------------------------------------------------------- the middleware


describe('emergencyHaltMiddleware — synchronous, zero DB reads on the request path', () => {
  function reqres(method: string, path = '/api/v1/agents/register') {
    const headers: Record<string, string> = {};
    const res = {
      statusCode: 0,
      body: undefined as any,
      setHeader(k: string, v: string) {
        headers[k] = v;
      },
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(payload: any) {
        res.body = payload;
        return res;
      },
    };
    const next = jest.fn();
    return { req: { method, path } as any, res: res as any, next, headers };
  }

  /** Prime the module's state without letting the middleware start a refresher. */
  async function primed(flag: boolean, mode: 'enforce' | 'shadow' = 'enforce') {
    const { client, calls } = fakeClient({ data: { emergency_halt: flag }, error: null });
    await checkEmergencyHalt(client, { mode, cacheMs: 0 });
    calls.from = 0; // only count reads made from here on
    return { client, calls };
  }

  afterEach(() => __stopEmergencyHaltRefresher());

  // THE regression test for what CI caught: the guard must not consume a DB
  // call, because doing so shifted a route test's sequenced mocks (200 -> 404)
  // and, in production, added a round-trip to every write in the system.
  it('makes ZERO database calls while guarding a mutating request', async () => {
    const { client, calls } = await primed(false);
    const { req, res, next } = reqres('POST');
    emergencyHaltMiddleware(client, { autoStartRefresher: false })(req, res, next);
    expect(calls.from).toBe(0);
    expect(next).toHaveBeenCalled();
  });

  it('makes zero database calls while halted, too', async () => {
    const { client, calls } = await primed(true);
    const { req, res, next } = reqres('POST');
    emergencyHaltMiddleware(client, { autoStartRefresher: false })(req, res, next);
    expect(calls.from).toBe(0);
    expect(res.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a mutating request with 503 + Retry-After while halted', async () => {
    const { client } = await primed(true);
    const { req, res, next, headers } = reqres('POST');
    emergencyHaltMiddleware(client, { autoStartRefresher: false })(req, res, next);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('emergency_halt');
    expect(headers['Retry-After']).toBe('30');
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s is refused while halted', async (method) => {
    const { client } = await primed(true);
    const { req, res, next } = reqres(method);
    emergencyHaltMiddleware(client, { autoStartRefresher: false })(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('%s passes through while halted — reads stay up', async (method) => {
    const { client } = await primed(true);
    const { req, res, next } = reqres(method, '/health');
    emergencyHaltMiddleware(client, { autoStartRefresher: false })(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });

  it('passes a mutating request through on the normal path', async () => {
    const { client } = await primed(false);
    const { req, res, next } = reqres('POST');
    emergencyHaltMiddleware(client, { autoStartRefresher: false })(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });

  it('honours an explicit allowPaths bypass', async () => {
    const { client } = await primed(true);
    const { req, res, next } = reqres('POST', '/api/v1/ops/unhalt');
    emergencyHaltMiddleware(client, { autoStartRefresher: false, allowPaths: ['/api/v1/ops/unhalt'] })(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('does not block writes in shadow mode', async () => {
    const { client } = await primed(true, 'shadow');
    process.env.EMERGENCY_HALT_MODE = 'shadow';
    const { req, res, next } = reqres('POST');
    emergencyHaltMiddleware(client, { autoStartRefresher: false })(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows writes but SAYS SO ONCE when state has never been read', () => {
    const { client } = fakeClient({ data: { emergency_halt: true }, error: null });
    const mw = emergencyHaltMiddleware(client, { autoStartRefresher: false });
    const a = reqres('POST');
    const b = reqres('POST');
    mw(a.req, a.res, a.next);
    mw(b.req, b.res, b.next);
    expect(a.next).toHaveBeenCalled();
    expect(b.next).toHaveBeenCalled();
    const warnings = warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('NOT protecting'));
    expect(warnings).toHaveLength(1);
  });

  it('starts the refresher by default so a mounted guard is never left unfed', async () => {
    const { client, calls } = fakeClient({ data: { emergency_halt: false }, error: null });
    emergencyHaltMiddleware(client);
    await new Promise((r) => setImmediate(r));
    expect(calls.from).toBe(1);
    expect(peekHaltState().initialized).toBe(true);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// COVERAGE PIN (added after an independent verifier found 11 uncovered tick
// loops, including the default-on on-chain ERC-8004 writer).
//
// The defect was not in any single file — it was that the module ASSERTED
// "worker tick loops PARK" while covering three of fourteen. Prose cannot hold
// that line. This test walks the filesystem: every `setInterval`-driven source
// file must either CALL the halt gate or appear on the EXEMPT list, whose
// reasons are written in the emergency-halt.ts header. A new worker added next
// month fails here until someone makes that choice on purpose.
//
// Built so it cannot pass vacuously — see the anti-vacuity cases below. The
// FIRST version of this very block was vacuous: it substring-matched
// `shouldParkForHalt` against the whole file, so deleting the CALL still left
// the IMPORT and the check reported the worker as covered. Two mutations that
// removed and then mis-ordered the gate both passed green against it. Imports
// are stripped before matching, and the matcher requires a call.
// ─────────────────────────────────────────────────────────────────────────────
describe('emergency halt — tick-loop coverage (filesystem-pinned)', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');

  const SRC = path.join(__dirname, '..', 'src');
  const NEWLINE = String.fromCharCode(10);

  // Exempt, each justified in the emergency-halt.ts header:
  //   health.ts                       — read-only liveness polling
  //   hitl-notification-dispatcher.ts — informs humans during an incident
  //   emergency-halt.ts               — IS the gate (its own refresher loop)
  //
  // `index.ts` USED TO BE ON THIS LIST, with the reason "mounts the middleware;
  // not a worker". That reason was FALSE and an independent verifier caught it:
  // index.ts defines and schedules SIX real tick loops inline, including
  // processCascadeQueue (a default-ON financial transition to 'escrowed' every
  // 60s) and runDailyAuditAnchor (an unconditional ON-CHAIN send). All six ran
  // straight through an active halt. It is now gated, and the rule below makes
  // that class of mistake un-repeatable: a blanket file exemption may cover AT
  // MOST ONE loop, so a multi-loop file can never again hide behind a single
  // justification. Coverage is counted PER LOOP, not per file — file
  // granularity is precisely what let six loops hide behind one line.
  const EXEMPT = new Set([
    'providers/health.ts',
    'services/hitl-notification-dispatcher.ts',
    'services/emergency-halt.ts',
  ]);

  const stripImports = (body: string) =>
    body.split(NEWLINE).filter((l) => !/^\s*import\b/.test(l)).join(NEWLINE);

  const CALLS_GATE = /\b(shouldParkForHalt|checkEmergencyHalt)\s*\(/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
    return out;
  }

  // Counted with plain string splits, NOT a regex. Two regex-based versions of
  // this counter returned 0 gates for EVERY file while the loop count stayed
  // correct — which reads as "nothing is gated" rather than as a broken
  // counter, i.e. the failure mode of a safety pin is to lie in the alarming
  // direction and waste the reader's time. The whitespace-tolerant regex is
  // still exercised by CALLS_GATE below; this counter just has to be right.
  const countOccurrences = (body: string, needle: string) =>
    body.split(needle).length - 1;
  const GATE_NAMES = ['shouldParkForHalt(', 'checkEmergencyHalt('];
  const countGates = (body: string) =>
    GATE_NAMES.reduce((n, name) => n + countOccurrences(body, name), 0);

  const files = walk(SRC).map((f) => {
    const body = fs.readFileSync(f, 'utf8');
    const code = stripImports(body);
    return {
      rel: path.relative(SRC, f).split(path.sep).join('/'),
      code,
      loopCount: countOccurrences(code, 'setInterval('),
      gateCount: countGates(code),
    };
  });
  const loops = files.filter((f) => f.loopCount > 0);

  it('ANTI-VACUITY: the matcher matches a CALL and not a bare import', () => {
    expect(CALLS_GATE.test("import { shouldParkForHalt } from './emergency-halt';")).toBe(false);
    expect(CALLS_GATE.test("if (await shouldParkForHalt(db, 'W')) return;")).toBe(true);
    expect(stripImports(["import { x } from 'y';", 'const a = 1;'].join(NEWLINE)))
      .not.toContain('import');
  });

  it('ANTI-VACUITY: the scan actually finds the tick loops', () => {
    expect(loops.length).toBeGreaterThanOrEqual(15);
    const rels = loops.map((l) => l.rel);
    expect(rels).toContain('workers/feedback-loop-worker.ts');
    expect(rels).toContain('workers/eas-anchor-worker.ts');
    expect(rels).toContain('services/x402-recovery-worker.ts');
  });

  it('the exempt list is real (each entry exists and really is a tick loop)', () => {
    for (const rel of EXEMPT) {
      expect(loops.map((l) => l.rel)).toContain(rel);
    }
  });

  it('EVERY tick-loop file either gates on the halt or is explicitly exempt', () => {
    const uncovered = loops
      .filter((l) => !EXEMPT.has(l.rel))
      .filter((l) => !CALLS_GATE.test(l.code))
      .map((l) => l.rel);
    expect(uncovered).toEqual([]);
  });

  // THE FIX FOR THE index.ts DEFECT. Presence of ONE gate in a file says
  // nothing about a file with SIX loops. Coverage is counted per loop.
  it('every tick-loop file has AT LEAST as many gate calls as loops', () => {
    const underGated = loops
      .filter((l) => !EXEMPT.has(l.rel))
      .filter((l) => l.gateCount < l.loopCount)
      .map((l) => `${l.rel} (${l.loopCount} loops, ${l.gateCount} gates)`);
    expect(underGated).toEqual([]);
  });

  // A blanket exemption is only honest over a single loop. index.ts carried one
  // justification over six loops and three of them mutated state or sent a
  // transaction; this makes that shape impossible rather than merely discouraged.
  it('no blanket exemption covers more than one loop', () => {
    const overBroad = [...EXEMPT]
      .map((rel) => files.find((f) => f.rel === rel)!)
      .filter((f) => f && f.loopCount > 1)
      .map((f) => `${f.rel} (${f.loopCount} loops under one exemption)`);
    expect(overBroad).toEqual([]);
  });

  it('index.ts is gated, not exempt (regression pin for the verifier finding)', () => {
    const idx = files.find((f) => f.rel === 'index.ts')!;
    expect(EXEMPT.has('index.ts')).toBe(false);
    expect(idx.loopCount).toBeGreaterThanOrEqual(6);
    expect(idx.gateCount).toBeGreaterThanOrEqual(idx.loopCount);
    // the three consequential ones, by name, so deleting any single gate fails
    for (const fn of ['processCascadeQueue', 'runDailyAuditAnchor', 'checkStalledAndAlert']) {
      expect(idx.code).toContain("shouldParkForHalt(db, '" + fn + "')");
    }
  });

  it('the on-chain writer gates BEFORE its circuit breaker', () => {
    // Ordering matters: a halt must not be maskable by breaker state.
    const code = files.find((f) => f.rel === 'workers/feedback-loop-worker.ts')!.code;
    const halt = code.search(CALLS_GATE);
    const breaker = code.indexOf('circuitOpenUntil > Date.now()');
    expect(halt).toBeGreaterThan(-1);
    expect(breaker).toBeGreaterThan(-1);
    expect(halt).toBeLessThan(breaker);
  });
});
