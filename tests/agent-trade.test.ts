/**
 * Generic agent↔agent trade (Task 4) — POST /api/v1/agent/:agentId/trade.
 *
 * Mocks db, x402-gate authority, and x402-real-settler. Verifies:
 *   - self-dealing (payer == target) → 402 PERMANENT
 *   - unknown agents → 404
 *   - tier authority denial → 402 with denial_reason + failure_class + next_step
 *   - settlement failure → 402 with failure classification
 *   - happy path → 200, settled, and TWO repid_events rows emitted (payer + payee)
 */

(global as any)._api_key_versions_table_checked = true;
(global as any).__agents = {};              // id -> row
(global as any).__authority = { authorized: true, denial_reason: null, tier: 'AUTONOMOUS', per_tx_limit: 1000, daily_limit: 10000, daily_remaining: 10000, daily_used: 0 };
(global as any).__settlement = { settlement_source: 'onchain_x402', tx_hash: '0xreal', basescan_url: 'u', is_real_settlement: true };
(global as any).__repidEventsInserts = [];

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
        insert: (rows: any) => {
          if (table === 'repid_events') (global as any).__repidEventsInserts.push(rows);
          return Promise.resolve({ data: null, error: null });
        },
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
  (global as any).__repidEventsInserts = [];
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
    expect((global as any).__repidEventsInserts).toHaveLength(0);
  });

  it('402s with PERMANENT class when settlement reports insufficient balance', async () => {
    (global as any).__settlement = { settlement_source: 'pending_funding', error: 'insufficient balance', is_real_settlement: false };
    const res = await request(app).post(`/api/v1/agent/${PAYER}/trade`).send({ target_agent_id: PAYEE, amount_usdc: 5 });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('settlement_failed');
    expect(res.body.failure_class).toBe('PERMANENT');
  });

  it('emits RepID events for BOTH agents on a settled trade (200)', async () => {
    const res = await request(app).post(`/api/v1/agent/${PAYER}/trade`).send({ target_agent_id: PAYEE, amount_usdc: 5 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('settled');
    expect(res.body.is_real_settlement).toBe(true);
    expect(res.body.repid_events_emitted).toBe(2);
    // one insert call carrying an array of two rows (payer + payee)
    const inserts = (global as any).__repidEventsInserts;
    expect(inserts).toHaveLength(1);
    const rows = inserts[0];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(2);
    const subjects = rows.map((r: any) => r.subject_id).sort();
    expect(subjects).toEqual([PAYER, PAYEE].sort());
    expect(rows.every((r: any) => r.subject_type === 'agent')).toBe(true);
  });
});
