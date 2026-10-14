/**
 * CodeQL triage fixes (CC1 2026-10-14).
 *
 * 1. js/polynomial-redos #5/#6/#7: EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/ is polynomial on long
 *    input, and the length cap ran AFTER it. express.json accepts 1 MB, so one unauthenticated
 *    POST could block the event loop for minutes (80 KB measured ~15 s). The cap now runs first.
 * 2. js/missing-rate-limiting #45: /bounties is mounted at '/', outside the global /api/v1 token
 *    bucket and ahead of authMiddleware, so nothing limited it.
 */

const fromMock = jest.fn();
jest.mock('../src/db', () => ({ db: { from: (...args: unknown[]) => fromMock(...args) } }));
jest.mock('../src/auth/api-keys', () => ({ validateAgentApiKey: jest.fn() }));
jest.mock('../src/engine/repid-update', () => ({ updateRepId: jest.fn() }));

import express from 'express';
import request from 'supertest';
import { validateApiKeyRequestBody } from '../src/routes/v1/api-key-requests';
import { validateFederationRegister } from '../src/routes/v1/federation';
import subscribeRouter from '../src/routes/subscribe';
import bountiesRouter, { BOUNTIES_LIMIT_PER_MIN } from '../src/routes/bounties';

// The shape CodeQL reports: many repetitions of 'a.' after an '@', with no valid ending.
// 40 KB: ~3 s of blocked event loop on the old order, so a regression fails fast instead of hanging.
const HOSTILE_EMAIL = 'a@' + 'a.'.repeat(20_000) + '@';
const timed = <T>(fn: () => T): { out: T; ms: number } => {
  const t = Date.now();
  const out = fn();
  return { out, ms: Date.now() - t };
};

describe('email validation rejects long input before the polynomial regex', () => {
  test('api-key request intake', () => {
    const { out, ms } = timed(() => validateApiKeyRequestBody({ email: HOSTILE_EMAIL, use_case: 'a long enough use case' }));
    expect(out).toEqual({ ok: false, error: 'email too long' });
    expect(ms).toBeLessThan(250);
  });

  test('federation register', () => {
    const { out, ms } = timed(() => validateFederationRegister({ owner_email: HOSTILE_EMAIL, node_url: 'https://node.example' } as any));
    expect(out).toMatchObject({ ok: false, error: 'owner_email too long' });
    expect(ms).toBeLessThan(250);
  });

  test('POST /subscribe', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(subscribeRouter);
    const t = Date.now();
    const res = await request(app).post('/subscribe').send({ email: HOSTILE_EMAIL });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_email');
    expect(Date.now() - t).toBeLessThan(1000);
    expect(fromMock).not.toHaveBeenCalled();
  });

  test('a normal email still passes validation', () => {
    expect(validateApiKeyRequestBody({ email: 'dev@example.com', use_case: 'a long enough use case' })).toMatchObject({ ok: true });
  });
});

describe('/bounties is rate-limited even though it sits outside /api/v1', () => {
  test(`GET /bounties: request ${BOUNTIES_LIMIT_PER_MIN + 1} in a minute from one IP → 429 with Retry-After`, async () => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: async () => ({ data: [], error: null }),
    };
    fromMock.mockImplementation(() => chain);
    const app = express();
    app.use(express.json());
    app.use(bountiesRouter);

    for (let i = 0; i < BOUNTIES_LIMIT_PER_MIN; i++) {
      const ok = await request(app).get('/bounties');
      expect(ok.status).toBe(200);
    }
    const limited = await request(app).get('/bounties');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});
