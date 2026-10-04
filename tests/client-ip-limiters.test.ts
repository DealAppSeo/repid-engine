/**
 * Rate limits key on the edge-set X-Real-IP, not on X-Forwarded-For (CWE-940).
 *
 * Each case runs a REAL express app with `trust proxy: 1`, the same setting as src/index.ts, so
 * `req.ip` is derived from X-Forwarded-For exactly as it is in production. A fake req with a fixed
 * `ip` would hide the bug: rotating the header would not move `req.ip`, and the old code would pass.
 *
 *   - ip-rate-limit.ts used the LEFTMOST X-Forwarded-For entry (whatever the caller wrote);
 *   - rate-limit.ts and the express-rate-limit instances used `req.ip` (the RIGHTMOST entry,
 *     trustworthy only if the edge appends, which Railway does not document).
 *
 * Either way, rotating the header got a fresh bucket per request. Each test below rotates it under
 * one X-Real-IP and expects the bucket to hold.
 */
import express from 'express';
import request from 'supertest';

// An in-memory stand-in for the Redis counter behind ip-rate-limit, so the bucket really fills.
const counts = new Map<string, number>();
jest.mock('../src/cache/rate-limiter', () => ({
  checkRateLimit: async (key: string, limit: number) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return { allowed: n <= limit, remaining: Math.max(0, limit - n), resetIn: 3600, count: n, backend: 'redis' };
  },
}));
jest.mock('../src/middleware/env-api-key', () => ({ hasValidEnvApiKey: () => false }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ipRateLimit } = require('../src/middleware/ip-rate-limit');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { rateLimitMiddleware, bucketStore, __test } = require('../src/middleware/rate-limit');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createClassifyRouter } = require('../src/routes/classify');

const CALLER = '203.0.113.7';
const OTHER = '198.51.100.20';
const xff = (i: number) => `10.9.${i}.${i}, 172.16.${i}.1`;

function appWith(...mw: express.RequestHandler[]) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(...mw);
  app.use((_req: express.Request, res: express.Response) => { res.status(200).json({ ok: true }); });
  return app;
}

beforeEach(() => {
  counts.clear();
  bucketStore.__reset();
  delete process.env.HAL_PUBLIC_GLOBAL_DAILY;
  delete process.env.RATE_LIMIT_BACKEND;
});

describe('ip-rate-limit (the public HAL `chat:` counter)', () => {
  const LIMIT = 3;
  const app = () => appWith(ipRateLimit(LIMIT, 3600));

  it('rotating X-Forwarded-For under one X-Real-IP does NOT reset the bucket', async () => {
    const a = app();
    for (let i = 0; i < LIMIT; i++) {
      const r = await request(a).post('/x').set('X-Real-IP', CALLER).set('X-Forwarded-For', xff(i));
      expect(r.status).toBe(200);
    }
    const over = await request(a).post('/x').set('X-Real-IP', CALLER).set('X-Forwarded-For', xff(99));
    expect(over.status).toBe(429);
  });

  it('a different X-Real-IP is a different caller', async () => {
    const a = app();
    for (let i = 0; i < LIMIT; i++) await request(a).post('/x').set('X-Real-IP', CALLER).set('X-Forwarded-For', xff(i));
    expect((await request(a).post('/x').set('X-Real-IP', CALLER)).status).toBe(429);
    expect((await request(a).post('/x').set('X-Real-IP', OTHER)).status).toBe(200);
  });

  it('a malformed X-Real-IP falls back to req.ip instead of becoming the bucket key', async () => {
    const a = app();
    const r = await request(a).post('/x').set('X-Real-IP', 'not-an-ip').set('X-Forwarded-For', `9.9.9.9, ${OTHER}`);
    expect(r.status).toBe(200);
    expect([...counts.keys()].filter((k) => k.startsWith('chat:'))).toEqual([`chat:${OTHER}`]);
  });
});

describe('rate-limit.ts (the global /api/v1 tiered limiter)', () => {
  const LIMIT: number = __test.TIER_LIMITS.IP_DEFAULT;
  const app = () => appWith(rateLimitMiddleware());

  it('rotating X-Forwarded-For under one X-Real-IP does NOT reset the bucket', async () => {
    const a = app();
    for (let i = 0; i < LIMIT; i++) {
      const r = await request(a).get('/api/v1/x').set('X-Real-IP', CALLER).set('X-Forwarded-For', xff(i));
      expect(r.status).toBe(200);
    }
    const over = await request(a).get('/api/v1/x').set('X-Real-IP', CALLER).set('X-Forwarded-For', xff(999));
    expect(over.status).toBe(429);
  });

  it('a different X-Real-IP is a different caller', async () => {
    const a = app();
    for (let i = 0; i < LIMIT; i++) await request(a).get('/api/v1/x').set('X-Real-IP', CALLER);
    expect((await request(a).get('/api/v1/x').set('X-Real-IP', CALLER)).status).toBe(429);
    expect((await request(a).get('/api/v1/x').set('X-Real-IP', OTHER)).status).toBe(200);
  });

  it('a malformed X-Real-IP falls back to req.ip', async () => {
    const a = app();
    for (let i = 0; i < LIMIT; i++) {
      await request(a).get('/api/v1/x').set('X-Real-IP', 'garbage').set('X-Forwarded-For', `9.9.9.${i}, ${OTHER}`);
    }
    // Those all keyed on req.ip (the rightmost entry, OTHER), so OTHER's bucket is spent...
    expect((await request(a).get('/api/v1/x').set('X-Forwarded-For', OTHER)).status).toBe(429);
    // ...and the same bogus header from a different req.ip is a different bucket, not a shared "garbage" one.
    expect((await request(a).get('/api/v1/x').set('X-Real-IP', 'garbage').set('X-Forwarded-For', CALLER)).status).toBe(200);
  });

  it('keeps the IPv6 /64 grouping on the trusted address', async () => {
    const a = app();
    for (let i = 0; i < LIMIT; i++) await request(a).get('/api/v1/x').set('X-Real-IP', `2001:db8:1:2::${i + 1}`);
    expect((await request(a).get('/api/v1/x').set('X-Real-IP', '2001:db8:1:2::ffff')).status).toBe(429);
  });
});

describe('express-rate-limit instances (classify as the representative)', () => {
  const LIMIT = 2;
  const app = () => {
    const a = express();
    a.set('trust proxy', 1);
    a.use(createClassifyRouter({ limit: LIMIT, classifier: () => 'pass' }));
    return a;
  };

  it('rotating X-Forwarded-For under one X-Real-IP does NOT reset the bucket', async () => {
    const a = app();
    for (let i = 0; i < LIMIT; i++) {
      const r = await request(a).post('/classify').set('X-Real-IP', CALLER).set('X-Forwarded-For', xff(i)).send({ text: 'hi' });
      expect(r.status).toBe(200);
    }
    const over = await request(a).post('/classify').set('X-Real-IP', CALLER).set('X-Forwarded-For', xff(99)).send({ text: 'hi' });
    expect(over.status).toBe(429);
  });

  it('a different X-Real-IP is a different caller', async () => {
    const a = app();
    for (let i = 0; i < LIMIT; i++) await request(a).post('/classify').set('X-Real-IP', CALLER).send({ text: 'hi' });
    expect((await request(a).post('/classify').set('X-Real-IP', CALLER).send({ text: 'hi' })).status).toBe(429);
    expect((await request(a).post('/classify').set('X-Real-IP', OTHER).send({ text: 'hi' })).status).toBe(200);
  });
});
