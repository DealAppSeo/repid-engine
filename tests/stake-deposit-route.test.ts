/**
 * POST /api/v1/stake/deposit — route-level wiring.
 *
 * stake-authorization.test.ts proves the DECISION is right. This proves the
 * decision is actually reached: the route is on the global auth bypass list, so
 * if the in-route check were ever dropped the endpoint would silently go back
 * to crediting anyone. A unit test on the service would not notice that.
 *
 * Also pins GET /stake/deposit/message as public — a front end fetches it before
 * the user is signed in, so gating it would break the flow it exists to serve.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy-key-for-import';
process.env.FULL_ACCOUNT_JWT_SECRET = process.env.FULL_ACCOUNT_JWT_SECRET || 'test-stake-route-secret';
process.env.NODE_ENV = 'test';

// DELIBERATELY NOT MOCKING ../src/db. The app's middleware chain touches the
// Supabase client on the way in, and a hand-rolled stub of it made every route
// 500 before reaching its handler — which would have let this whole file pass
// vacuously while proving nothing. Pointed at a dead localhost, supabase-js
// fails fast with connection-refused, every lookup comes back empty, and
// authorization lands on account_not_found. That is exactly the state we want to
// assert against: the check RAN, and an unauthorized 200 is what this file
// exists to catch.

import request from 'supertest';
import app from '../src/index';

const WALLET = '0x1111111111111111111111111111111111111111';
const TX = '0x' + 'a'.repeat(64);
const AMOUNT = '5000000';

describe('POST /api/v1/stake/deposit — authorization is reached, not bypassed', () => {
  it('still validates required fields before anything else', async () => {
    const res = await request(app).post('/api/v1/stake/deposit').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/builder_address and amount required/);
  });

  // One real round trip, deliberately. It is slow (supabase-js takes ~15s to
  // give up on the dead host) but it is the assertion that actually matters:
  // an anonymous, well-formed deposit must not be credited. The full decision
  // matrix — sessions, signatures, replays — is covered fast and in isolation
  // by stake-authorization.test.ts; this one guards the wiring.
  it(
    'does NOT credit an anonymous, well-formed deposit',
    async () => {
      const res = await request(app)
        .post('/api/v1/stake/deposit')
        .send({ builder_address: WALLET, amount: AMOUNT });
      expect(res.status).not.toBe(200);
      expect(res.body.ok).not.toBe(true);
      // Whatever the reason, it must be an authorization one — not a crash that
      // happens to look like a rejection.
      expect(['no_credential', 'account_not_found', 'invalid_session']).toContain(res.body.error);
    },
    30000,
  );
});

describe('GET /api/v1/stake/deposit/message — public, and exact', () => {
  it('is reachable without any credential', async () => {
    const res = await request(app)
      .get('/api/v1/stake/deposit/message')
      .query({ wallet: WALLET, amount: AMOUNT, tx_hash: TX });
    expect(res.status).toBe(200);
    expect(typeof res.body.message).toBe('string');
  });

  it('returns exactly the string the server will verify against', async () => {
    const { stakeDepositMessage } = require('../src/services/stake-authorization');
    const res = await request(app)
      .get('/api/v1/stake/deposit/message')
      .query({ wallet: WALLET, amount: AMOUNT, tx_hash: TX });
    expect(res.body.message).toBe(
      stakeDepositMessage({ wallet: WALLET, amount: AMOUNT, txHash: TX }),
    );
  });

  it('400s on a missing parameter rather than signing an incomplete claim', async () => {
    const res = await request(app)
      .get('/api/v1/stake/deposit/message')
      .query({ wallet: WALLET, amount: AMOUNT });
    expect(res.status).toBe(400);
  });
});
