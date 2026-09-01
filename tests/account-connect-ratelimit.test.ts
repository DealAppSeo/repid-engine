/**
 * A CEILING ON THE ONE PUBLIC SURFACE THAT MINTS AN IDENTITY.
 *
 * `POST /api/v1/account/connect` inserts a durable row into `builders` for a wallet nobody
 * has seen before, and generating a wallet is free. Before this limiter existed the route
 * had no ceiling of any kind: every rate limiter in the engine is path-specific
 * (`/agents/register`, `/agents/:id/score-event`, `/agents/:id/card`,
 * `/agents-external/…/score-event`, `/subscribe`) and none of them covered this path, nor was
 * any limiter mounted globally ahead of the byok router. Measured before the change, not
 * assumed.
 *
 * WHY THE 503 → 429 TRANSITION IS THE WHOLE TEST.
 *
 * Express runs middleware in mount order. A limiter registered AFTER `app.use('/api/v1',
 * byokRouter)` would never execute, because the router answers the request first — the
 * ceiling would exist in the source, read correctly to a reviewer, and do nothing. That is
 * this repository's signature defect: a system reporting a protection it has not earned.
 *
 * With `SELF_SERVE_ACCOUNTS_ENABLED` unset (the production default), the HANDLER returns 503
 * `disabled`. So:
 *
 *   - if the limiter is mounted correctly, the first five calls reach the handler (503) and
 *     the sixth is stopped before it (429);
 *   - if the limiter is mounted too late, ALL SIX return 503 and nothing is limited.
 *
 * One assertion therefore distinguishes "the limiter works" from "the limiter is decorative",
 * which asserting `429` alone never could. The anchor test below deliberately proves the
 * pre-limit requests still reach the handler, so a future change that accidentally blocks
 * everything cannot pass by making the 429 arrive sooner.
 *
 * THE FLAG IS NEVER SET IN THIS FILE. Turning it on would test the open path while claiming
 * to prove the bounded one.
 */
// src/config.ts throws without these, and importing the real app pulls it in. Defaults only —
// they never reach a network, because the db module is mocked below. Same idiom as
// tests/byok-issuance-gate.test.ts, the closest neighbour on this surface.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

// SELF_SERVE_ACCOUNTS_ENABLED is deliberately left unset: the 503 it produces is what proves
// the pre-limit requests reached the handler. Setting it would test the open path.

jest.mock('../src/db', () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    ilike: () => chain,
    limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    insert: () => ({
      select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      then: (resolve: any) => resolve({ data: null, error: null }),
    }),
  };
  return { db: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});

import request from 'supertest';
import app from '../src/index';

const PATH = '/api/v1/account/connect';

describe('POST /api/v1/account/connect — the ceiling is real, not decorative', () => {
  it('lets the first five through to the handler, then stops the sixth', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app).post(PATH).send({});
      seen.push(res.status);
    }

    // The first five REACHED the handler. 503 is the feature flag answering, which can only
    // happen inside byokRouter — so the limiter let them past, and the route is still wired.
    expect(seen.slice(0, 5)).toEqual([503, 503, 503, 503, 503]);

    // The sixth never got there. If the limiter were mounted after byokRouter this would be a
    // sixth 503 and the ceiling would be doing nothing at all.
    expect(seen[5]).toBe(429);
  });

  it('names itself in the refusal, so a caller can tell a ceiling from an outage', async () => {
    // The window from the previous test is still open — this request is over the limit.
    const res = await request(app).post(PATH).send({});
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('too_many_connects');
    // A 429 that says nothing is indistinguishable from the service being down.
    expect(String(res.body.message)).toMatch(/try again/i);
  });

  it('does not throttle the rest of the byok surface', async () => {
    // The limiter is path-scoped. If it had been mounted on '/api/v1' or on the router, the
    // exhausted window above would now be blocking unrelated public reads.
    const res = await request(app).get('/api/v1/byok/providers');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('enabled');
  });
});
