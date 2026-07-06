/**
 * P0-B honesty — GET /hashkey/anchor/:agentId must NOT fabricate an on-chain tx.
 *
 * Before the fix this route returned `anchored:true` with a fake `mockTxHash`
 * and a live-looking explorer URL (→ 404). A money/trust surface must never
 * present a fabricated transaction as real. These tests pin the honest shape:
 *   - anchored:false, status:'pending_onchain_anchor', onchain_write_implemented:false
 *   - no fabricated transaction / explorer URL by default
 *   - the real, locally-computed commitment leaf hash is still returned
 *   - a simulated tx only appears when MOCK_HASHKEY_ANCHOR=true and is labelled
 */

// config.ts throws at import if these are unset; set dummies before any import.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

const VALID_ID = '11111111-2222-4333-8444-555555555555';

(global as any).__hkAgentRow = {
  id: VALID_ID,
  agent_name: 'SOPHIA',
  current_repid: 1000,
  tier: 'ESTABLISHED',
  erc8004_address: null,
};

jest.mock('../src/db', () => ({
  db: {
    from: (tableName: string) => {
      if (tableName === 'repid_score_events') {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: async () => ({ data: [], error: null }),
        };
        return chain;
      }
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        single: async () => {
          const ar = (global as any).__hkAgentRow ?? null;
          return { data: ar, error: ar ? null : { message: 'not found' } };
        },
      };
      return chain;
    },
  },
}));

// hashkey-chain testHashKeyConnection is not exercised by /anchor, but the route
// module imports it; stub to avoid a live RPC.
jest.mock('../src/engine/hashkey-chain', () => ({
  testHashKeyConnection: async () => ({ connected: false }),
}));

import express from 'express';
import request from 'supertest';
import hashkeyRouter from '../src/routes/hashkey';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/', hashkeyRouter);
  return app;
}

describe('GET /hashkey/anchor/:agentId — honest (no fabricated tx)', () => {
  const OLD_ENV = process.env.MOCK_HASHKEY_ANCHOR;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.MOCK_HASHKEY_ANCHOR;
    else process.env.MOCK_HASHKEY_ANCHOR = OLD_ENV;
  });

  it('reports NOT anchored and returns no fabricated transaction by default', async () => {
    delete process.env.MOCK_HASHKEY_ANCHOR;
    const res = await request(makeApp()).get(`/hashkey/anchor/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.anchored).toBe(false);
    expect(res.body.status).toBe('pending_onchain_anchor');
    expect(res.body.onchain_write_implemented).toBe(false);
    // No fabricated tx or explorer URL anywhere in the payload.
    expect(res.body.transaction).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/explorerUrl.*\/tx\//);
    // The real, locally-computed commitment leaf is still present.
    expect(res.body.commitment.leafHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('only emits a clearly-labelled SIMULATED tx when MOCK_HASHKEY_ANCHOR=true', async () => {
    process.env.MOCK_HASHKEY_ANCHOR = 'true';
    const res = await request(makeApp()).get(`/hashkey/anchor/${VALID_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.anchored).toBe(false); // still honestly not anchored
    expect(res.body.transaction).not.toBeNull();
    expect(res.body.transaction.is_simulated).toBe(true);
    expect(res.body.transaction.explorerUrl).toBeUndefined();
  });
});
