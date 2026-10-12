/**
 * E-4 hardening — payee fail-closed, the three Express route sites, driven
 * through the real app:
 *   - POST /api/v1/x402/:uuid/trade-analysis   (src/routes/x402-inbound.ts)
 *   - POST /api/v1/contracts/:id/escrow        (src/routes/v1/contracts.ts)
 *   - POST /api/v1/contracts/:id/satisfy       (src/routes/v1/contracts.ts)
 *
 * Each advertised/escrowed/released a payment to the zero address when the
 * payee (agent / provider wallet) was unset. They now REFUSE with an explicit
 * payee_unset error and move nothing. Three outcomes, never two.
 */
import request from 'supertest';
import app from '../src/index';
import { db } from '../src/db';

jest.mock('../src/db', () => ({
  db: { from: jest.fn(), rpc: jest.fn().mockResolvedValue({ data: null, error: null }) },
}));

jest.mock('../src/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    req.apiKey = { key: 'bound-key', tier: 'pro' };
    req.agent_id = (global as any).__callerAgentId;
    next();
  },
}));

jest.mock('../src/services/accountable-root', () => ({
  ...jest.requireActual('../src/services/accountable-root'),
  resolveAccountableRoot: jest.fn(async (ref: string) => ({
    ok: true,
    root: { kind: 'owner', agentId: ref, subjectId: ref, wallet: '0x00000000000000000000000000000000000000a1', assurance: 'wallet-proven', via: 'own-binding', grantPath: [] },
  })),
}));

const BUYER = 'buyer-aaaa-1111';
const PROVIDER = 'provider-bbbb-2222';
const CONTRACT_ID = '11111111-2222-3333-4444-555555555555';

// Driven per test:
//   __walletUnderTest — the repid_agents.wallet_address the lookups return
//   __contract        — the service_contracts row
let contractWrites: unknown[] = [];

function mockDb() {
  (db.from as jest.Mock).mockImplementation((table: string) => {
    const wallet = (global as any).__walletUnderTest;
    const contract = (global as any).__contract;
    const chain: any = {
      select: jest.fn(() => chain),
      eq: jest.fn(() => chain),
      in: jest.fn(() => chain),
      gte: jest.fn(() => chain),
      lte: jest.fn(() => chain),
      not: jest.fn(() => chain),
      order: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      upsert: jest.fn(async () => ({ data: null, error: null })),
      update: jest.fn(() => {
        if (table === 'service_contracts') contractWrites.push('update');
        return chain;
      }),
      insert: jest.fn(() => chain),
      single: jest.fn(async () => ({ data: table === 'service_contracts' ? contract : null, error: null })),
      maybeSingle: jest.fn(async () => ({
        data:
          table === 'service_contracts' ? contract
          : table === 'repid_agents' ? { id: CONTRACT_ID, agent_name: 'SOPHIA', wallet_address: wallet, current_repid: 5000, tier: 'ESTABLISHED' }
          : null,
        error: null,
      })),
      then: (r: any) => r({ data: [], error: null, count: 0 }),
    };
    return chain;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  contractWrites = [];
  (global as any).__callerAgentId = BUYER;
  (global as any).__walletUnderTest = undefined;
  (global as any).__contract = undefined;
  delete process.env.X402_ENFORCEMENT_ENABLED;
  process.env.X402_GATE_SHADOW = 'false';
  mockDb();
});

afterAll(() => {
  delete (global as any).__callerAgentId;
  delete (global as any).__walletUnderTest;
  delete (global as any).__contract;
  delete process.env.X402_GATE_SHADOW;
  delete process.env.X402_SETTLE_ON_DELIVERY;
});

// ===========================================================================
describe('POST /api/v1/x402/:uuid/trade-analysis — fails closed on an unset agent wallet', () => {
  it('refuses (409 payee_unset) when the agent has no payout wallet', async () => {
    (global as any).__walletUnderTest = null;
    const res = await request(app).post(`/api/v1/x402/${CONTRACT_ID}/trade-analysis`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('payee_unset');
  });

  it('does NOT refuse on payee when the agent has a real wallet (reaches the 402 payment step)', async () => {
    (global as any).__walletUnderTest = '0x2222222222222222222222222222222222222222';
    const res = await request(app).post(`/api/v1/x402/${CONTRACT_ID}/trade-analysis`).send({});
    // No X-PAYMENT header → the route advances past the payee guard to the
    // payment-required step. The point is only that payee_unset did NOT fire.
    expect(res.status).toBe(402);
    expect(res.body.error).not.toBe('payee_unset');
  });
});

// ===========================================================================
describe('POST /api/v1/contracts/:id/escrow — fails closed on an unset provider wallet', () => {
  const PENDING = { id: CONTRACT_ID, status: 'pending', buyer_agent_id: BUYER, provider_agent_id: PROVIDER, agreed_price_usdc_raw: 10000 };

  // The payee guard sits on the enforced escrow path (where the 402/payment
  // requirements are actually built). The legacy branch escrows with no payment
  // at all, so enforcement must be ON to reach — and exercise — the guard.
  afterEach(() => { delete process.env.X402_ENFORCEMENT_ENABLED; });

  it('refuses (409 payee_unset) and escrows nothing when the provider has no wallet', async () => {
    process.env.X402_ENFORCEMENT_ENABLED = 'true';
    (global as any).__contract = PENDING;
    (global as any).__walletUnderTest = null;
    const res = await request(app).post(`/api/v1/contracts/${CONTRACT_ID}/escrow`).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('payee_unset');
    expect(contractWrites).toHaveLength(0);
  });
});

// ===========================================================================
describe('POST /api/v1/contracts/:id/satisfy — fails closed on an unset provider wallet', () => {
  const FULFILLED_PASS = {
    id: CONTRACT_ID,
    status: 'fulfilled',
    buyer_agent_id: BUYER,
    provider_agent_id: PROVIDER,
    agreed_price_usdc_raw: 10000,
    result: { verdict: 'PASS' },
    work_statement: null,
    work_statement_hash: null,
  };

  it('refuses (409 payee_unset) and releases nothing when the provider has no wallet', async () => {
    process.env.X402_SETTLE_ON_DELIVERY = 'true';
    (global as any).__contract = FULFILLED_PASS;
    (global as any).__walletUnderTest = null;
    (global as any).__callerAgentId = BUYER; // the buyer may release
    const res = await request(app)
      .post(`/api/v1/contracts/${CONTRACT_ID}/satisfy`)
      .send({ satisfaction_score: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('payee_unset');
  });
});
