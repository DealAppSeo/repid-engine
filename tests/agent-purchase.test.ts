/**
 * Marketplace PURCHASE surface — POST /api/v1/agent/:providerAgentId/purchase
 * (and the /trade purchase-shape backward-compat path).
 *
 * Reconciles the trustshell frontend contract (lib/repid-engine.ts::purchaseService):
 *   body: { buyer_agent_id, service_type, provider_agent_id? }
 *   200 -> { ok, tx_hash, settlement_url, repid_delta, receipt_id }
 *   402 -> { ok:false, error, x402_challenge }
 *
 * Mocks db (repid_agents + agent_services catalog), x402-gate authority, the
 * x402-real-settler, and the repid-update engine. Verifies: catalog resolution →
 * raw-transfer delegation → envelope shape, service-not-found 404, authority denial → 402
 * with x402_challenge, and that a settled purchase moves BOTH agents' RepID via updateRepId()
 * (buyer = payer, provider = payee) — the golden loop.
 */

// Satisfy src/config.ts boot guard without touching the (gitignored, worktree-absent)
// .env — set dummy Supabase creds before src/index is imported. The db module is fully
// mocked below, so these are never used for a real connection.
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test-key';

(global as any)._api_key_versions_table_checked = true;
(global as any).__agents = {}; // id -> row
(global as any).__services = []; // agent_services rows
(global as any).__authority = { authorized: true, denial_reason: null, tier: 'AUTONOMOUS', per_tx_limit: 1000, daily_limit: 10000, daily_remaining: 10000, daily_used: 0 };
(global as any).__settlement = { settlement_source: 'onchain_x402', tx_hash: '0xreal', basescan_url: 'https://sepolia.basescan.org/tx/0xreal', is_real_settlement: true };
(global as any).__updateRepIdCalls = [];

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const chain: any = {
        _filters: {},
        select: () => chain,
        eq: (col: string, val: any) => {
          chain._filters[col] = val;
          chain._eqVal = val;
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => {
          if (table === 'repid_agents') {
            return { data: (global as any).__agents[chain._eqVal] ?? null, error: null };
          }
          if (table === 'agent_services') {
            const rows: any[] = (global as any).__services;
            const match = rows.find(
              (r) =>
                r.provider_agent_id === chain._filters.provider_agent_id &&
                r.service_type === chain._filters.service_type &&
                (chain._filters.active === undefined || r.active === chain._filters.active),
            );
            return { data: match ?? null, error: null };
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

// Mock the scoring engine: capture calls + return a moved score per agent so the purchase test
// proves the golden loop (settlement → updateRepId → new_repid/tier/badges) buyer=payer, provider=payee.
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
      newBadges: [],
    };
  }),
}));

import request from 'supertest';
import app from '../src/index';

const BUYER = '11111111-1111-4111-8111-111111111111';
const PROVIDER = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  (global as any).__agents = {
    [BUYER]: { id: BUYER, agent_name: 'BUYER', current_repid: 6000, tier: 'AUTONOMOUS' },
    [PROVIDER]: { id: PROVIDER, agent_name: 'PROVIDER', current_repid: 3000, tier: 'ESTABLISHED' },
  };
  (global as any).__services = [
    {
      id: 'svc-1',
      provider_agent_id: PROVIDER,
      service_type: 'code_review',
      service_name: 'Deep Code Review',
      base_price_usdc_raw: 500_000, // 0.5 USDC in raw 6-decimal micro-USDC
      min_repid_to_purchase: 500,
      active: true,
    },
  ];
  (global as any).__authority = { authorized: true, denial_reason: null, tier: 'AUTONOMOUS', per_tx_limit: 1000, daily_limit: 10000, daily_remaining: 10000, daily_used: 0 };
  (global as any).__settlement = { settlement_source: 'onchain_x402', tx_hash: '0xreal', basescan_url: 'https://sepolia.basescan.org/tx/0xreal', is_real_settlement: true };
  (global as any).__updateRepIdCalls = [];
});

describe('POST /api/v1/agent/:providerAgentId/purchase', () => {
  it('400s on missing buyer_agent_id / service_type', async () => {
    const r1 = await request(app).post(`/api/v1/agent/${PROVIDER}/purchase`).send({ service_type: 'code_review' });
    expect(r1.status).toBe(400);
    expect(r1.body.ok).toBe(false);
    const r2 = await request(app).post(`/api/v1/agent/${PROVIDER}/purchase`).send({ buyer_agent_id: BUYER });
    expect(r2.status).toBe(400);
    expect(r2.body.ok).toBe(false);
  });

  it('404s service_not_found when no active catalog match', async () => {
    const res = await request(app)
      .post(`/api/v1/agent/${PROVIDER}/purchase`)
      .send({ buyer_agent_id: BUYER, service_type: 'nonexistent_service' });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('service_not_found');
  });

  it('resolves the catalog price and returns the frontend envelope on success (200)', async () => {
    const res = await request(app)
      .post(`/api/v1/agent/${PROVIDER}/purchase`)
      .send({ buyer_agent_id: BUYER, service_type: 'code_review', provider_agent_id: PROVIDER });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tx_hash).toBe('0xreal');
    expect(res.body.settlement_url).toBe('https://sepolia.basescan.org/tx/0xreal');
    expect(typeof res.body.repid_delta).toBe('number');
    expect(res.body.receipt_id).toBeTruthy();
    // resolved price = 500_000 raw / 1e6 = 0.5 USDC
    expect(res.body.amount_usdc).toBe(0.5);
    expect(res.body.service_type).toBe('code_review');
  });

  it('MOVES both agents RepID via updateRepId() on a settled purchase (golden loop)', async () => {
    const res = await request(app)
      .post(`/api/v1/agent/${PROVIDER}/purchase`)
      .send({ buyer_agent_id: BUYER, service_type: 'code_review' });
    expect(res.status).toBe(200);
    // updateRepId() was called for BOTH agents: buyer=payer, provider=payee.
    const calls = (global as any).__updateRepIdCalls;
    expect(calls).toHaveLength(2);
    const byAgent = Object.fromEntries(calls.map((c: any) => [c.agentId, c]));
    expect(byAgent[BUYER].eventType).toBe('AGENT_TRADE_PAYER');
    expect(byAgent[PROVIDER].eventType).toBe('AGENT_TRADE_PAYEE');
    // envelope surfaces the moved RepID / tier for both parties
    expect(res.body.buyer_new_repid).toBe(6003);
    expect(res.body.provider_new_repid).toBe(3005);
    expect(res.body.buyer_new_tier).toBe('AUTONOMOUS');
    expect(res.body.provider_new_tier).toBe('ESTABLISHED');
    expect(Array.isArray(res.body.buyer_badges_awarded)).toBe(true);
    expect(Array.isArray(res.body.provider_badges_awarded)).toBe(true);
  });

  it('402s with x402_challenge when tier authority denies', async () => {
    (global as any).__authority = { authorized: false, denial_reason: 'exceeds_per_tx_limit', tier: 'EARNING', per_tx_limit: 10, daily_limit: 50, daily_remaining: 50, daily_used: 0 };
    const res = await request(app)
      .post(`/api/v1/agent/${PROVIDER}/purchase`)
      .send({ buyer_agent_id: BUYER, service_type: 'code_review' });
    expect(res.status).toBe(402);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('tier_authority_denied');
    expect(res.body.x402_challenge).toBeDefined();
    expect(res.body.x402_challenge.amount_usdc).toBe(0.5);
    expect(res.body.x402_challenge.service_type).toBe('code_review');
    // no score movement on a denied purchase
    expect((global as any).__updateRepIdCalls).toHaveLength(0);
  });

  it('402s (settlement failure) with ok:false envelope', async () => {
    (global as any).__settlement = { settlement_source: 'pending_funding', error: 'insufficient balance', is_real_settlement: false };
    const res = await request(app)
      .post(`/api/v1/agent/${PROVIDER}/purchase`)
      .send({ buyer_agent_id: BUYER, service_type: 'code_review' });
    expect(res.status).toBe(402);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('settlement_failed');
  });
});

describe('POST /api/v1/agent/:agentId/trade — purchase-shape backward-compat', () => {
  it('treats a { buyer_agent_id, service_type } body as a purchase and returns the envelope', async () => {
    const res = await request(app)
      .post(`/api/v1/agent/${PROVIDER}/trade`)
      .send({ buyer_agent_id: BUYER, service_type: 'code_review', provider_agent_id: PROVIDER });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tx_hash).toBe('0xreal');
    expect(res.body.settlement_url).toBe('https://sepolia.basescan.org/tx/0xreal');
    expect(res.body.receipt_id).toBeTruthy();
  });

  it('still handles the RAW transfer shape { target_agent_id, amount_usdc }', async () => {
    const res = await request(app)
      .post(`/api/v1/agent/${BUYER}/trade`)
      .send({ target_agent_id: PROVIDER, amount_usdc: 5 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('settled');
    expect(res.body.repid_events_emitted).toBe(2);
  });
});
