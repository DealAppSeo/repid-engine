/**
 * The market has to be visible to be joinable.
 *
 * An agent that finds /.well-known/agent.json, reads /openapi.json and decides it
 * wants work could not previously SEE that a market exists: GET
 * /api/v1/negotiation/rfqs was 401. Discovery documents are worthless if the
 * thing they describe is behind a key you can only get from a human.
 *
 * What must stay closed is the competitive information — the bids. Those are
 * participant-only, and this pins that the opening did not take them with it.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy-key-for-import';
process.env.FULL_ACCOUNT_JWT_SECRET = process.env.FULL_ACCOUNT_JWT_SECRET || 'test-market-board-secret';
process.env.NODE_ENV = 'test';

// Not mocking src/db: the app's middleware chain touches the Supabase client on
// the way in, and a hand-rolled stub made every route 500 before reaching its
// handler (learned the hard way in stake-deposit-route.test.ts). Pointed at a
// dead localhost, what matters here is still decided correctly — whether the
// request gets PAST authMiddleware — and that is what these assert.
import request from 'supertest';
import app from '../src/index';

describe('RFQ board is public', () => {
  it('GET /negotiation/rfqs is not 401 — an agent can see the market keyless', async () => {
    const res = await request(app).get('/api/v1/negotiation/rfqs');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  }, 30000);

  it('GET /negotiation/rfqs/:id is not 401', async () => {
    const res = await request(app).get('/api/v1/negotiation/rfqs/11111111-1111-4111-8111-111111111111');
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
  }, 30000);
});

describe('bids stay closed — opening the board did not open the bidding', () => {
  it('GET /negotiation/rfqs/:id/bids still requires a credential', async () => {
    const res = await request(app).get(
      '/api/v1/negotiation/rfqs/11111111-1111-4111-8111-111111111111/bids',
    );
    expect([401, 403]).toContain(res.status);
  }, 30000);

  it('POST /negotiation/rfqs/:id/bids still requires a credential', async () => {
    const res = await request(app)
      .post('/api/v1/negotiation/rfqs/11111111-1111-4111-8111-111111111111/bids')
      .send({ price_usdc_raw: '1' });
    expect([401, 403]).toContain(res.status);
  }, 30000);

  it('POST /negotiation/rfqs (creating an RFQ) still requires a credential', async () => {
    const res = await request(app).post('/api/v1/negotiation/rfqs').send({ service_type: 'verification' });
    expect([401, 403]).toContain(res.status);
  }, 30000);
});

describe('self-serve key surface announces itself', () => {
  it('GET /agent-keys is public and says whether it is enabled', async () => {
    const res = await request(app).get('/api/v1/agent-keys');
    expect(res.status).toBe(200);
    expect(typeof res.body.enabled).toBe('boolean');
    expect(res.body.scopes).not.toContain('admin');
    expect(Array.isArray(res.body.how)).toBe(true);
  }, 30000);

  it('challenge requires an agent_id rather than 500ing', async () => {
    const res = await request(app).post('/api/v1/agent-keys/challenge').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bad_request');
  }, 30000);

  it('issue requires both nonce and signature', async () => {
    const res = await request(app).post('/api/v1/agent-keys/issue').send({ nonce: 'x' });
    expect(res.status).toBe(400);
  }, 30000);
});
