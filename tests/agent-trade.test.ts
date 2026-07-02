/**
 * Generic agent↔agent trade (Task 4) — POST /api/v1/agent/:agentId/trade.
 *
 * Mocks db, x402-gate authority, x402-real-settler, and the repid-update engine. Verifies:
 *   - self-dealing (payer == target) → 402 PERMANENT
 *   - unknown agents → 404
 *   - tier authority denial → 402 with denial_reason + failure_class + next_step
 *   - settlement failure → 402 with failure classification
 *   - happy path → 200, settled, and (golden loop) updateRepId() MOVES both agents'
 *     current_repid, so the response surfaces new_repid / new_tier / badges for both.
 */

// Satisfy src/config.ts boot guard without touching the (gitignored, worktree-absent)
// .env — set dummy Supabase creds before src/index is imported. db is mocked below.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

(global as any)._api_key_versions_table_checked = true;
(global as any).__agents = {};              // id -> row
(global as any).__authority = { authorized: true, denial_reason: null, tier: 'AUTONOMOUS', per_tx_limit: 1000, daily_limit: 10000, daily_remaining: 10000, daily_used: 0 };
(global as any).__settlement = { settlement_source: 'onchain_x402', tx_hash: '0xreal', basescan_url: 'u', is_real_settlement: true };
// Records every updateRepId() call so we can prove BOTH agents' scores are moved through the pipeline.
(global as any).__updateRepIdCalls = [];

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const chain: any = {
        select: () => chain,
        eq: (_col: string, val: any) => { chain._eqVal = val; return chain; },
        maybeSingle: async () => {
          if (table === 'repid_agents') {
            return { data: (global as any).__agents[chain._eqVal] ?? null, error: null };
          }
          return { data: null, error: null };
        },
        insert: () => Promise.resolve({ data: null, error: null }),
      };
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

jest.mock('../src/services/x402-gate', () => ({
  checkTransactionAuthority: async () => (global as any).__authority,
}));

jest.mock('../src/services/x402-real-settler', () => ({
  settleX402Payment: async () => (global as any).__settlement,
}));

// Mock the scoring engine: capture calls and return a moved score / tier / badge per agent so the
// route test proves the golden loop (settlement → updateRepId → new_repid/tier/badges) end to end.
jest.mock('../src/engine/repid-update', () => ({
  updateRepId: jest.fn(async (input: any) => {
    (global as any).__updateRepIdCalls.push(input);
    const agent = (global as any).__agents[input.agentId] ?? { agent_name: 'unknown', current_repid: 0 };
    const delta = input.eventType === 'AGENT_TRADE_PAYER' ? 3 : 5;
    const repIdAfter = (agent.current_repid ?? 0) + delta;
    const tier = repIdAfter >= 8000 ? 'VETERAN' : repIdAfter >= 5000 ? 'AUTONOMOUS' : repIdAfter >= 1000 ? 'ESTABLISHED' : repIdAfter >= 500 ? 'EARNING' : 'PROBATIONARY';
    return {
      agentId: input.agentId,
      agentName: agent.agent_name,
      repIdBefore: agent.current_repid ?? 0,
      repIdAfter,
      delta,
      tier,
      ecosystemNeedWeight: 1,
      redemptionModifierApplied: false,
      constitutionalAudit: { passed: true, complianceScore: 1, halMode: 0, easAttestationId: '', easSchema: '', processingMs: 0 },
      newBadges: input.eventType === 'AGENT_TRADE_PAYEE' ? [{ badge: 'FIRST_DELIVERY' }] : [],
    };
  }),
}));

import request from 'supertest';
import app from '../src/index';

const PAYER = '11111111-1111-4111-8111-111111111111';
const PAYEE = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  (global as any).__agents = {
    [PAYER]: { id: PAYER, agent_name: 'PAYER', current_repid: 6000, tier: 'AUTONOMOUS' },
    [PAYEE]: { id: PAYEE, agent_name: 'PAYEE', current_repid: 3000, tier: 'ESTABLISHED' },
  };
  (global as any).__authority = { authorized: true, denial_reason: null, tier: 'AUTONOMOUS', per_tx_limit: 1000, daily_limit: 10000, daily_remaining: 10000, daily_used: 0 };
  (global as any).__settlement = { settlement_source: 'onchain_x402', tx_hash: '0xreal', basescan_url: 'u', is_real_settlement: true };
  (global as any).__updateRepIdCalls = [];
});

describe('POST /api/v1/agent/:agentId/trade', () => {
  it('400s on missing/invalid input', async () => {
    const r1 = await request(app).post(`/api/v1/agent/${PAYER}/trade`).send({ amount_usdc: 5 });
    expect(r1.status).toBe(400);
    const r2 = await request(app).post(`/api/v1/agent/${PAYER}/trade`).send({ target_agent_id: PAYEE, amount_usdc: 0 });
    expect(r2.status).toBe(400);
  });

  it('402s self_dealing_forbidden when payer == target (Task 3)', async () => {
    const res = await request(app).post(`/api/v1/agent/${PAYER}/trade`).send({ target_agent_id: PAYER, amount_usdc: 5 });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('self_dealing_forbidden');
    expect(res.body.failure_class).toBe('PERMANENT');
  });

  it('404s when payer or target agent not found', async () => {
    const res = await request(app).post(`/api/v1/agent/${PAYER}/trade`).send({ target_agent_id: '33333333-3333-4333-8333-333333333333', amount_usdc: 5 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('target_agent_not_found');
  });

  it('402s with denial_reason + next_step when tier authority denies', async () => {
    (global as any).__authority = { authorized: false, denial_reason: 'exceeds_per_tx_limit', tier: 'EARNING', per_tx_limit: 10, daily_limit: 50, daily_remaining: 50, daily_used: 0 };
    const res = await request(app).post(`/api/v1/agent/${PAYER}/trade`).send({ target_agent_id: PAYEE, amount_usdc: 500 });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('tier_authority_denied');
    expect(res.body.denial_reason).toBe('exceeds_per_tx_limit');
    expect(res.body.failure_class).toBe('PERMANENT');
    expect(res.body.next_step).toBeTruthy();
    // no score movement on a denied trade
    expect((global as any).__updateRepIdCalls).toHaveLength(0);
  });

  it('402s with PERMANENT class when settlement reports insufficient balance', async () => {
    (global as any).__settlement = { settlement_source: 'pending_funding', error: 'insufficient balance', is_real_settlement: false };
    const res = await request(app).post(`/api/v1/agent/${PAYER}/trade`).send({ target_agent_id: PAYEE, amount_usdc: 5 });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('settlement_failed');
    expect(res.body.failure_class).toBe('PERMANENT');
    // settlement never succeeded → no score movement
    expect((global as any).__updateRepIdCalls).toHaveLength(0);
  });

  it('MOVES both agents current_repid via updateRepId() on a settled trade (200) — the golden loop', async () => {
    const res = await request(app).post(`/api/v1/agent/${PAYER}/trade`).send({ target_agent_id: PAYEE, amount_usdc: 5 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('settled');
    expect(res.body.is_real_settlement).toBe(true);

    // updateRepId() was called for BOTH agents with the new golden-loop event types.
    const calls = (global as any).__updateRepIdCalls;
    expect(calls).toHaveLength(2);
    const byAgent = Object.fromEntries(calls.map((c: any) => [c.agentId, c]));
    expect(byAgent[PAYER].eventType).toBe('AGENT_TRADE_PAYER');
    expect(byAgent[PAYEE].eventType).toBe('AGENT_TRADE_PAYEE');

    // The response surfaces the moved RepID / tier / badges (the trade→RepID→tier→badge chain).
    expect(res.body.payer_new_repid).toBe(6003);   // 6000 + payer delta 3
    expect(res.body.target_new_repid).toBe(3005);  // 3000 + payee delta 5
    expect(res.body.payer_new_tier).toBe('AUTONOMOUS');
    expect(res.body.target_new_tier).toBe('ESTABLISHED');
    expect(res.body.payer_repid_delta).toBe(3);
    expect(res.body.target_repid_delta).toBe(5);
    // payee crosses a badge milestone in this mock → badges surfaced
    expect(Array.isArray(res.body.target_badges_awarded)).toBe(true);
    expect(res.body.target_badges_awarded.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.payer_badges_awarded)).toBe(true);
  });
});
