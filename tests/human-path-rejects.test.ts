/**
 * The human walk's rejecting doors, with a database that only counts inserts.
 *
 * empty connect, flag open, no signature → 401 signature_required, no insert
 * empty stake → 400 missing fields, no insert
 * token signup flag off → 410, no insert
 * GET /api/v1/human/path → 200, applied false on every step
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.SELF_SERVE_ACCOUNTS_ENABLED = 'true';
delete process.env.TOKEN_SIGNUP_ENABLED;

jest.mock('../src/db', () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    ilike: () => chain,
    neq: () => chain,
    in: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    upsert: async () => ({ error: null }),
    insert: () => {
      (globalThis as { __hpInserts?: number }).__hpInserts =
        ((globalThis as { __hpInserts?: number }).__hpInserts ?? 0) + 1;
      return {
        select: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
          single: async () => ({ data: { id: '00000000-0000-0000-0000-000000000001' }, error: null }),
        }),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      };
    },
  };
  return { db: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});

import request from 'supertest';
import app from '../src/index';

function inserts(): number {
  return (globalThis as { __hpInserts?: number }).__hpInserts ?? 0;
}

describe('human path rejects before any insert', () => {
  it('GET /api/v1/human/path is the shadow, applied false on every step', async () => {
    const before = inserts();
    const res = await request(app).get('/api/v1/human/path');
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.steps.length).toBe(6);
    expect(res.body.steps.every((s: { applied: boolean }) => s.applied === false)).toBe(true);
    expect(res.body.testnet_tokens.dispenses).toBe(false);
    expect(inserts()).toBe(before);
  });

  it('empty connect with the door open is 401 signature_required and inserts nothing', async () => {
    const before = inserts();
    const res = await request(app).post('/api/v1/account/connect').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('signature_required');
    expect(inserts()).toBe(before);
  });

  it('empty stake is 400 missing fields and inserts nothing', async () => {
    const before = inserts();
    const res = await request(app).post('/api/v1/stake/deposit').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/builder_address and amount required/);
    expect(inserts()).toBe(before);
  });

  it('token signup stays 410 and inserts nothing unless the flag is exactly true', async () => {
    const before = inserts();
    const closed = await request(app).post('/api/v1/builder/token-signup').send({});
    expect(closed.status).toBe(410);
    expect(closed.body.error).toBe('token_signup_closed');
    expect(closed.body.applied).toBe(false);
    expect(inserts()).toBe(before);

    process.env.TOKEN_SIGNUP_ENABLED = 'TRUE';
    const ignored = await request(app).post('/api/v1/builder/token-signup').send({});
    expect(ignored.status).toBe(410);
    expect(inserts()).toBe(before);

    process.env.TOKEN_SIGNUP_ENABLED = 'true';
    const open = await request(app).post('/api/v1/builder/token-signup').send({});
    expect(open.status).not.toBe(410);
    expect(inserts()).toBeGreaterThan(before);
    delete process.env.TOKEN_SIGNUP_ENABLED;
  });
});
