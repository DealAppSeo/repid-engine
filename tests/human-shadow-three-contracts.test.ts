/**
 * Three contracts, and nothing else.
 *
 *   unbound agent → deny
 *   missing stake → deny
 *   signature_required → no insert
 *
 * decideAuthority is not imported and not modified.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
process.env.SELF_SERVE_ACCOUNTS_ENABLED = 'true';

jest.mock('../src/db', () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    ilike: () => chain,
    limit: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
    insert: () => {
      (globalThis as { __contractInserts?: number }).__contractInserts =
        ((globalThis as { __contractInserts?: number }).__contractInserts ?? 0) + 1;
      return {
        select: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
          single: async () => ({ data: null, error: null }),
        }),
      };
    },
  };
  return { db: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});

import express from 'express';
import request from 'supertest';
import { shadowHumanSpend } from '../src/services/human-spend-shadow';
import byokRouter from '../src/routes/v1/byok';

function inserts(): number {
  return (globalThis as { __contractInserts?: number }).__contractInserts ?? 0;
}

describe('human shadow contracts', () => {
  it('an unbound agent is denied', () => {
    const result = shadowHumanSpend({
      amountUsdc: 1,
      agentCapUsdc: 100,
      ownerCapUsdc: 100,
      bound: false,
      stakeAvailableUsdc: 50,
    });
    expect(result.spend).toBe('deny');
    expect(result.reason).toBe('unbound_agent');
    expect(result.applied).toBe(false);
    expect(result.enforced).toBe(false);
  });

  it('a missing stake is denied', () => {
    const result = shadowHumanSpend({
      amountUsdc: 1,
      agentCapUsdc: 100,
      ownerCapUsdc: 25,
      bound: true,
    });
    expect(result.spend).toBe('deny');
    expect(result.reason).toBe('stake_not_checked');
    expect(result.applied).toBe(false);
    expect(result.enforced).toBe(false);
  });

  it('signature_required means no insert', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', byokRouter);

    const before = inserts();
    const res = await request(app).post('/api/v1/account/connect').send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('signature_required');
    expect(inserts()).toBe(before);
  });
});
