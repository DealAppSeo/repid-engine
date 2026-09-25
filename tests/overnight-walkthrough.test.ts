/**
 * MOCKED NETWORK. The database is a double. Nothing here dials production,
 * moves ETH, or calls token signup.
 *
 * Covers the walk that is already on main: after-create, the human path,
 * honesty A, readiness exact_true, and an empty wallet connect.
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
      (globalThis as { __overnightInserts?: number }).__overnightInserts =
        ((globalThis as { __overnightInserts?: number }).__overnightInserts ?? 0) + 1;
      return {
        select: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
          single: async () => ({ data: null, error: null }),
        }),
      };
    },
  };
  const failedVoteRead = {
    select: () => ({
      gte: () => ({
        limit: async () => ({ data: null, error: { message: 'vote table unavailable' } }),
      }),
    }),
  };
  return {
    db: {
      from: (table: string) => (table === 'hal_quorum_validator_votes' ? failedVoteRead : chain),
      rpc: async () => ({ data: null, error: null }),
    },
  };
});

import request from 'supertest';
import app from '../src/index';
import { EXACT_TRUE_FLAGS } from '../src/config/flag-readiness';

function inserts(): number {
  return (globalThis as { __overnightInserts?: number }).__overnightInserts ?? 0;
}

describe('overnight walkthrough (mocked network)', () => {
  it('GET /api/v1/after-create can verify and cannot stake', async () => {
    const res = await request(app).get('/api/v1/after-create');
    expect(res.status).toBe(200);
    expect(res.body.can_verify).toBe(true);
    expect(res.body.can_stake).toBe(false);
  });

  it('GET /api/v1/human/path applies nothing', async () => {
    const res = await request(app).get('/api/v1/human/path');
    expect(res.status).toBe(200);
    expect(res.body.steps.length).toBeGreaterThan(0);
    expect(res.body.steps.every((step: { applied: boolean }) => step.applied === false)).toBe(true);
    expect(res.body.testnet_tokens.dispenses).toBe(false);
  });

  it('GET /api/v1/hal/honesty-a failed read is NOT_CHECKED and carries no claim text or user id', async () => {
    const res = await request(app).get('/api/v1/hal/honesty-a');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('NOT_CHECKED');
    expect(res.body.rows).toBeNull();
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('user_id');
    expect(text).not.toContain('agent_id');
    expect(text).not.toMatch(/claim text|prompt_text/);
  });

  it('GET /readiness exposes the exact_true keys from main', async () => {
    const res = await request(app).get('/readiness');
    expect(res.status).toBe(200);
    for (const flag of EXACT_TRUE_FLAGS) {
      expect(res.body.exact_true).toHaveProperty(flag.name);
      expect(typeof res.body.exact_true[flag.name]).toBe('boolean');
    }
    expect(EXACT_TRUE_FLAGS.map((flag) => flag.name)).toEqual(
      expect.arrayContaining(['REAL_STAKING_ENABLED', 'OWNER_CEILING_SHADOW_ENABLED']),
    );
  });

  it('POST /api/v1/account/connect with an empty body is 401 and inserts nothing', async () => {
    const before = inserts();
    const res = await request(app).post('/api/v1/account/connect').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('signature_required');
    expect(inserts()).toBe(before);
  });
});
