/**
 * llm-cost-hal-budget.test.ts — POST /api/v1/hal/evaluate (keyless; each fresh evaluation fans out to
 * the provider quorum) cannot be billed by a crowd, a cache hit spends no budget, and one caller's
 * context cannot set another caller's cached verdict. 2026-10-14, public LLM-cost abuse.
 */
const checkRateLimit = jest.fn();
jest.mock('../src/cache/rate-limiter', () => ({ checkRateLimit: (...a: unknown[]) => checkRateLimit(...a) }));
jest.mock('../src/middleware/env-api-key', () => ({ hasValidEnvApiKey: () => false }));
jest.mock('../src/middleware/rate-limit', () => ({ resolveByokIdentity: async () => ({ valid: false }) }));
jest.mock('../src/db', () => ({ db: { from: () => ({ insert: () => Promise.resolve({ error: null }) }) } }));
const evaluate = jest.fn(async () => ({ hal_score: 0.1, decision: 'pass', mode: 'fact-check' }));
jest.mock('../src/hal/service', () => ({ halService: { evaluate: (...a: unknown[]) => (evaluate as any)(...a) } }));
const cacheReads: string[] = [];
let cachedValue: unknown = null;
jest.mock('../src/cache/hal-cache', () => ({
  getCachedHalResult: async (_t: string, provider: string) => {
    cacheReads.push(provider);
    return cachedValue;
  },
  cacheHalResult: async () => undefined,
}));

import express from 'express';
import request from 'supertest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ipRateLimit } = require('../src/middleware/ip-rate-limit');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const halEvaluate = require('../src/routes/hal-evaluate');

const counted = (allowed: boolean, remaining = 1) => ({ allowed, remaining, resetIn: 30, backend: 'memory' });

/** The production chain: cache-first, then the public limiter, then the route. */
function appWith(limiter: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/hal/evaluate', halEvaluate.halCacheFirst, limiter);
  app.use('/api/v1/hal', halEvaluate.default);
  return app;
}
const post = (app: express.Express, ip: string, body: Record<string, unknown> = { text: 'Paris is the capital of France.' }) =>
  request(app).post('/api/v1/hal/evaluate').set('X-Real-IP', ip).send(body);

let err: jest.SpyInstance;
beforeEach(() => {
  checkRateLimit.mockReset();
  evaluate.mockClear();
  cacheReads.length = 0;
  cachedValue = null;
  delete process.env.HAL_PUBLIC_GLOBAL_PER_MIN;
  delete process.env.HAL_PUBLIC_GLOBAL_DAILY;
  err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('cache first: a hit spends no budget', () => {
  it('a cached verdict is served without touching the limiter or the providers', async () => {
    cachedValue = { hal_score: 0.1, decision: 'pass' };
    const limiter = jest.fn((_q: express.Request, _s: express.Response, next: express.NextFunction) => next());
    const res = await post(appWith(limiter), '198.51.100.1');
    expect(res.status).toBe(200);
    expect(res.body.cached).toBe(true);
    expect(res.headers['x-hal-cache']).toBe('hit');
    expect(limiter).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('a miss goes through the limiter and is evaluated once', async () => {
    const limiter = jest.fn((_q: express.Request, _s: express.Response, next: express.NextFunction) => next());
    const res = await post(appWith(limiter), '198.51.100.1');
    expect(res.status).toBe(200);
    expect(limiter).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});

describe('the cache key holds what changes the verdict', () => {
  it('no context: the key is unchanged (sdefault:er1)', async () => {
    await post(appWith((_q, _s, n) => n()), '198.51.100.1');
    expect(cacheReads).toContain('sdefault:er1');
  });

  it('a context (product/domain/certainty) gets its own key, so it can neither read nor fill the no-context entry', async () => {
    await post(appWith((_q, _s, n) => n()), '198.51.100.1', { text: 'Paris is the capital of France.', context: { product: 'trustchat', certainty: 0.2 } });
    expect(cacheReads.length).toBeGreaterThan(0);
    for (const k of cacheReads) expect(k).toMatch(/^sdefault:er1:c[0-9a-f]{16}$/);
    // and two different contexts never share one
    cacheReads.length = 0;
    await post(appWith((_q, _s, n) => n()), '198.51.100.1', { text: 'Paris is the capital of France.', context: { product: 'trustchat', certainty: 0.9 } });
    const second = cacheReads[0];
    cacheReads.length = 0;
    await post(appWith((_q, _s, n) => n()), '198.51.100.1', { text: 'Paris is the capital of France.', context: { product: 'trustchat', certainty: 0.2 } });
    expect(cacheReads[0]).not.toBe(second);
  });
});

describe('the global per-minute ceiling (rotating IPs)', () => {
  it('each IP is under its own cap, the shared minute is spent: 429 NOT_CHECKED with a reason, logged once', async () => {
    process.env.HAL_PUBLIC_GLOBAL_PER_MIN = '30';
    checkRateLimit.mockImplementation(async (key: string) =>
      key === 'hal:free:global:minute' ? counted(false, 0) : counted(true, 5));
    const app = appWith(ipRateLimit(10, 86400));
    const a = await post(app, '198.51.100.1');
    const b = await post(app, '198.51.100.2');
    for (const res of [a, b]) {
      expect(res.status).toBe(429);
      expect(res.body).toMatchObject({ error: 'FREE_TIER_BUSY', label: 'not-checked', reason: 'global_minute_budget_spent' });
    }
    expect(evaluate).not.toHaveBeenCalled();
    const loud = err.mock.calls.filter((c) => /GLOBAL MINUTE BUDGET SPENT/.test(String(c[0])));
    expect(loud).toHaveLength(1);
    // a refusal for the minute did not spend the day
    expect(checkRateLimit.mock.calls.map((c) => c[0])).not.toContain('hal:free:global');
  });

  it('the daily ceiling now says NOT_CHECKED and why', async () => {
    checkRateLimit.mockImplementation(async (key: string) => (key === 'hal:free:global' ? counted(false, 0) : counted(true, 5)));
    const res = await post(appWith(ipRateLimit(10, 86400)), '198.51.100.3');
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'FREE_TIER_EXHAUSTED', label: 'not-checked', reason: 'global_daily_budget_spent' });
  });

  it('normal traffic is unaffected: under every budget the evaluation runs', async () => {
    checkRateLimit.mockResolvedValue(counted(true, 5));
    const res = await post(appWith(ipRateLimit(10, 86400)), '198.51.100.4');
    expect(res.status).toBe(200);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});
