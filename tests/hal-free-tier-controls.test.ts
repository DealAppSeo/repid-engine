/**
 * The two controls on the keyless HAL surface (2026-08-25).
 *
 * MEASURED, not hypothesised: a cold run of the published SDK quickstart against
 * the live backend exhausted the keyless budget in about fifteen minutes of
 * ordinary development and returned `x-ratelimit-limit: 10, remaining: 0,
 * reset: 55717`. The quickstart makes two calls.
 *
 * Two separate defects, and this file pins the fix for each:
 *
 *   1. A BYOK caller — someone paying their own way through a token that
 *      `rate-limit.ts` has resolved to an unmetered bypass for a long time — was
 *      still subject to the anonymous per-IP cap, because this middleware knew
 *      nothing about BYOK.
 *
 *   2. There was no ceiling on total free-tier spend. Per-IP caps bound each
 *      stranger and bound nothing about the bill.
 *
 * THE LOAD-BEARING ASSERTIONS ARE THE FAIL-CLOSED ONES. The ceiling and the
 * per-IP cap deliberately fail in OPPOSITE directions, and that asymmetry is the
 * thing most likely to be "tidied up" by someone who notices the inconsistency
 * and does not know why it is there. If `uncountable` starts resolving to
 * `next()`, the spend control is gone while every happy-path test stays green —
 * so those cases are asserted explicitly, and they are the reason this file
 * exists rather than a single smoke test.
 */
import type { Request, Response, NextFunction } from 'express';

const checkRateLimit = jest.fn();
const hasValidEnvApiKey = jest.fn();
const resolveByokIdentity = jest.fn();

jest.mock('../src/cache/rate-limiter', () => ({ checkRateLimit: (...a: unknown[]) => checkRateLimit(...a) }));
jest.mock('../src/middleware/env-api-key', () => ({ hasValidEnvApiKey: (...a: unknown[]) => hasValidEnvApiKey(...a) }));
jest.mock('../src/middleware/rate-limit', () => ({ resolveByokIdentity: (...a: unknown[]) => resolveByokIdentity(...a) }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ipRateLimit } = require('../src/middleware/ip-rate-limit');

/** A counter that answered normally. */
const counted = (allowed: boolean, remaining = 0) => ({
  allowed, remaining, resetIn: 3600, count: 1, backend: 'redis',
});
/** The store was unreachable — `checkRateLimit` reports this, and it is NOT "under budget". */
const uncountable = () => ({
  allowed: true, remaining: 10, resetIn: 3600, count: 0, backend: 'fail-open',
});

function run(headers: Record<string, string> = {}) {
  const req = { method: 'POST', headers, ip: '203.0.113.7', socket: {} } as unknown as Request;
  const res: any = {
    statusCode: 0, body: undefined, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { this.headers[k.toLowerCase()] = v; },
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
  };
  const next = jest.fn() as unknown as NextFunction;
  return { req, res, next, served: () => (next as jest.Mock).mock.calls.length === 1 && res.statusCode === 0 };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.HAL_PUBLIC_GLOBAL_DAILY;
  delete process.env.HAL_PUBLIC_GLOBAL_FAIL_OPEN;
  delete process.env.HAL_BYOK_DAILY;
  hasValidEnvApiKey.mockReturnValue(false);
  resolveByokIdentity.mockResolvedValue({ valid: false, keyId: null });
  checkRateLimit.mockResolvedValue(counted(true, 5));
});

describe('a BYOK caller gets their OWN budget, not the free tier and not infinity', () => {
  // THE CORRECTION THIS BLOCK ENCODES. The first version of this middleware gave
  // a BYOK caller `next()` with no counter, justified in a comment as "a BYOK
  // caller pays for their own usage." They do not. /hal/evaluate reads only
  // {text, context, strictness, source}; nothing under src/hal/ imports the
  // key-custody service; the issuance endpoint itself says the token
  // `does_not_grant: ["access to provider keys"]`. Every BYOK evaluation spends
  // OUR provider credits, so an unmetered token was an unbounded bill wearing a
  // name that implied the opposite.

  it('is metered against its own token budget, not the shared counters', async () => {
    resolveByokIdentity.mockResolvedValue({ valid: true, keyId: 'tok-1' });
    checkRateLimit.mockResolvedValueOnce(counted(true, 499));
    const { req, res, next, served } = run({ authorization: 'Bearer hdg_byok_abc' });
    await ipRateLimit(10, 86400)(req, res, next);

    expect(served()).toBe(true);
    expect(res.headers['x-ratelimit-bucket']).toBe('byok');
    // Exactly one counter, and it is keyed to the TOKEN. Keyed to the IP, a room
    // of testers behind one NAT would starve each other — which is the problem
    // issuing tokens is supposed to solve.
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
    expect(checkRateLimit).toHaveBeenCalledWith('hal:byok:tok-1', 500, 86_400);
  });

  it('two different tokens do not share a budget', async () => {
    resolveByokIdentity.mockResolvedValueOnce({ valid: true, keyId: 'tok-A' });
    const a = run({ authorization: 'Bearer hdg_byok_a' });
    await ipRateLimit(10, 86400)(a.req, a.res, a.next);

    resolveByokIdentity.mockResolvedValueOnce({ valid: true, keyId: 'tok-B' });
    const b = run({ authorization: 'Bearer hdg_byok_b' });
    await ipRateLimit(10, 86400)(b.req, b.res, b.next);

    const keys = checkRateLimit.mock.calls.map((c) => c[0]);
    expect(keys).toEqual(['hal:byok:tok-A', 'hal:byok:tok-B']);
  });

  it('REFUSES once that token has spent its budget', async () => {
    resolveByokIdentity.mockResolvedValue({ valid: true, keyId: 'tok-1' });
    checkRateLimit.mockResolvedValueOnce(counted(false, 0));
    const { req, res, next, served } = run({ authorization: 'Bearer hdg_byok_abc' });
    await ipRateLimit(10, 86400)(req, res, next);

    expect(served()).toBe(false);
    // 429 here, unlike the ceiling's 503: this caller really did spend their own
    // allowance, so "too many requests" is a true statement about them.
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toBe('BYOK_BUDGET_EXHAUSTED');
  });

  it('REFUSES when the token budget cannot be counted', async () => {
    // Same rule as the ceiling: if it cannot count, it cannot bound. Holding a
    // token does not entitle anyone to unlimited spend during a store outage.
    resolveByokIdentity.mockResolvedValue({ valid: true, keyId: 'tok-1' });
    checkRateLimit.mockResolvedValueOnce(uncountable());
    const { req, res, next, served } = run({ authorization: 'Bearer hdg_byok_abc' });
    await ipRateLimit(10, 86400)(req, res, next);

    expect(served()).toBe(false);
    expect(res.statusCode).toBe(503);
    expect(res.body.error).toBe('BYOK_BUDGET_UNAVAILABLE');
  });

  it('is unmetered ONLY when HAL_BYOK_DAILY is explicitly 0', async () => {
    process.env.HAL_BYOK_DAILY = '0';
    resolveByokIdentity.mockResolvedValue({ valid: true, keyId: 'tok-1' });
    const { req, res, next, served } = run({ authorization: 'Bearer hdg_byok_abc' });
    await ipRateLimit(10, 86400)(req, res, next);

    expect(served()).toBe(true);
    expect(res.headers['x-ratelimit-bypass']).toBe('byok-unmetered');
    expect(checkRateLimit).not.toHaveBeenCalled();
  });

  it('falls through to anonymous treatment when the token is not valid', async () => {
    resolveByokIdentity.mockResolvedValue({ valid: false, keyId: null });
    const { req, res, next } = run({ authorization: 'Bearer hdg_byok_forged' });
    await ipRateLimit(10, 86400)(req, res, next);
    expect(res.headers['x-ratelimit-bucket']).toBeUndefined();
    expect(checkRateLimit).toHaveBeenCalledWith(expect.stringContaining('chat:'), 10, 86400);
  });

  it('does not grant a budget when the BYOK lookup throws', async () => {
    // A resolver outage must not become a free pass of any size.
    resolveByokIdentity.mockRejectedValue(new Error('lookup down'));
    const { req, res, next } = run({ authorization: 'Bearer hdg_byok_abc' });
    await ipRateLimit(10, 86400)(req, res, next);
    expect(res.headers['x-ratelimit-bucket']).toBeUndefined();
    expect(checkRateLimit).toHaveBeenCalledWith(expect.stringContaining('chat:'), 10, 86400);
  });
});

describe('the global ceiling bounds total free-tier spend', () => {
  it('refuses with FREE_TIER_EXHAUSTED once the shared budget is spent', async () => {
    process.env.HAL_PUBLIC_GLOBAL_DAILY = '2000';
    checkRateLimit
      .mockResolvedValueOnce(counted(true, 9))   // per-IP: fine
      .mockResolvedValueOnce(counted(false, 0)); // global: spent
    const { req, res, next, served } = run();
    await ipRateLimit(10, 86400)(req, res, next);

    expect(served()).toBe(false);
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toBe('FREE_TIER_EXHAUSTED');
  });

  it('checks the caller\'s own budget BEFORE the shared one', async () => {
    // Otherwise a caller already over their own allowance burns shared headroom
    // on the way to being refused.
    checkRateLimit.mockResolvedValueOnce(counted(false, 0));
    const { req, res, next } = run();
    await ipRateLimit(10, 86400)(req, res, next);
    expect(res.body.error).toBe('RATE_LIMITED');
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it('can be disabled explicitly with 0', async () => {
    process.env.HAL_PUBLIC_GLOBAL_DAILY = '0';
    const { req, res, next, served } = run();
    await ipRateLimit(10, 86400)(req, res, next);
    expect(served()).toBe(true);
    expect(checkRateLimit).toHaveBeenCalledTimes(1); // per-IP only
  });
});

describe('fail direction — the asymmetry is the control', () => {
  it('REFUSES free traffic when the counter is unreachable', async () => {
    // If it cannot count, it cannot bound. A spend control that resolves
    // "I don't know" to "go ahead" is not a control. This is the assertion that
    // breaks if someone makes the ceiling fail open to match the per-IP cap.
    checkRateLimit
      .mockResolvedValueOnce(counted(true, 9))
      .mockResolvedValueOnce(uncountable());
    const { req, res, next, served } = run();
    await ipRateLimit(10, 86400)(req, res, next);

    expect(served()).toBe(false);
    expect(res.statusCode).toBe(503); // not 429 — the caller did nothing wrong
    expect(res.body.error).toBe('FREE_TIER_UNAVAILABLE');
    expect(res.body.reason).toBe('usage_counter_unreachable');
  });

  it('serves anyway when fail-open is opted into deliberately', async () => {
    process.env.HAL_PUBLIC_GLOBAL_FAIL_OPEN = 'true';
    checkRateLimit
      .mockResolvedValueOnce(counted(true, 9))
      .mockResolvedValueOnce(uncountable());
    const { req, res, next, served } = run();
    await ipRateLimit(10, 86400)(req, res, next);
    expect(served()).toBe(true);
  });

  it('only exactly "true" opts out — a typo must not silently disable the ceiling', async () => {
    for (const v of ['1', 'yes', 'TRUE!', '', 'false']) {
      jest.clearAllMocks();
      process.env.HAL_PUBLIC_GLOBAL_FAIL_OPEN = v;
      checkRateLimit
        .mockResolvedValueOnce(counted(true, 9))
        .mockResolvedValueOnce(uncountable());
      const { req, res, next } = run();
      await ipRateLimit(10, 86400)(req, res, next);
      expect(res.statusCode).toBe(503);
    }
  });

  it('an env-allowlist key still bypasses everything, unchanged', async () => {
    hasValidEnvApiKey.mockReturnValue(true);
    const { req, res, next, served } = run({ 'x-api-key': 'operator' });
    await ipRateLimit(10, 86400)(req, res, next);
    expect(served()).toBe(true);
    expect(res.headers['x-ratelimit-bypass']).toBe('api-key');
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});
