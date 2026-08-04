import request from 'supertest';
import app from '../../src/index';
import { db } from '../../src/db';

// Mock authentication.
//
// `agent_id` added 2026-08-04: /escrow now requires a caller bound to an agent that
// is a PARTY to the contract, and `apiKey` alone is the shared-REPID_API_KEYS shape
// that carries no identity. 'buyer-123' is the buyer on this suite's contract
// fixture.
jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.apiKey = { key: 'test-key', tier: 'premium' };
    req.agent_id = 'buyer-123';
    next();
  }
}));

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    gt: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    lt: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    ilike: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    match: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockReturnThis(),
    rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
    upsert: jest.fn().mockResolvedValue({ data: null, error: null })
  }
}));

describe('Audit Trail Integration', () => {
  let dbState: {
    contracts: Record<string, any>;
    settlements: Record<string, any>;
    agents: Record<string, any>;
    services: Record<string, any>;
  };

  beforeEach(() => {
    jest.clearAllMocks();

    dbState = {
      contracts: {},
      settlements: {},
      agents: {
        'buyer-123': { id: 'buyer-123', current_repid: 200, wallet_address: '0xBuyerWallet' },
        'provider-123': { id: 'provider-123', current_repid: 150, wallet_address: '0xProviderWallet' }
      },
      services: {
        'service-123': { id: 'service-123', active: true, min_repid_to_purchase: 100, base_price_usdc_raw: 10000, provider_agent_id: 'provider-123' }
      }
    };

    jest.spyOn(db, 'from').mockImplementation((table: string) => {
      return {
        select: jest.fn().mockReturnThis(),
        insert: jest.fn().mockImplementation((data: any) => {
          const id = data.id || `mock-uuid-${Math.random().toString(36).substring(2, 9)}`;
          const row = { id, x402_payment_id: null, ...data };
          if (table === 'service_contracts') {
            dbState.contracts[id] = row;
          } else if (table === 'x402_settlements') {
            dbState.settlements[id] = row;
          }
          return {
            select: jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({ data: row, error: null })
          } as any;
        }),
        update: jest.fn().mockImplementation((updates: any) => {
          return {
            eq: jest.fn().mockImplementation((col: string, val: any) => {
              if (col === 'id' && dbState.contracts[val]) {
                const updated = { ...dbState.contracts[val], ...updates };
                dbState.contracts[val] = updated;
                return {
                  select: jest.fn().mockReturnThis(),
                  single: jest.fn().mockResolvedValue({ data: updated, error: null }),
                  maybeSingle: jest.fn().mockResolvedValue({ data: updated, error: null })
                } as any;
              }
              return {
                select: jest.fn().mockReturnThis(),
                single: jest.fn().mockResolvedValue({ data: null, error: null }),
                maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null })
              } as any;
            })
          } as any;
        }),
        eq: jest.fn().mockImplementation((col: string, val: any) => {
          const chainObj: any = {
            // Defensive chain methods — return self so any further chaining (eg .gte before
            // maybeSingle) doesn't TypeError. The actual terminal is maybeSingle below.
            gte: jest.fn().mockReturnThis(),
            gt: jest.fn().mockReturnThis(),
            lte: jest.fn().mockReturnThis(),
            lt: jest.fn().mockReturnThis(),
            not: jest.fn().mockReturnThis(),
            is: jest.fn().mockReturnThis(),
            neq: jest.fn().mockReturnThis(),
            in: jest.fn().mockReturnThis(),
            match: jest.fn().mockReturnThis(),
            ilike: jest.fn().mockReturnThis(),
            order: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockImplementation(() => {
              if (table === 'service_contracts') {
                return Promise.resolve({ data: dbState.contracts[val] || null, error: null });
              } else if (table === 'repid_agents') {
                return Promise.resolve({ data: dbState.agents[val] || null, error: null });
              } else if (table === 'agent_services') {
                return Promise.resolve({ data: dbState.services[val] || null, error: null });
              } else if (table === 'x402_settlements') {
                const s = Object.values(dbState.settlements).find((x: any) => x[col] === val);
                return Promise.resolve({ data: s || null, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            })
          };
          return chainObj as any;
        }),
        gte: jest.fn().mockReturnThis(),
        not: jest.fn().mockReturnThis(),
        is: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        upsert: jest.fn().mockResolvedValue({ data: null, error: null })
      } as any;
    });
  });

  afterAll(() => {
    delete process.env.X402_ENFORCEMENT_ENABLED;
  });

  test('persists tx_hash and settled_at in escrow settlement', async () => {
    process.env.X402_ENFORCEMENT_ENABLED = 'true';

    // 1. Create a contract first
    const createRes = await request(app)
      .post('/api/v1/contracts')
      .send({
        service_id: 'service-123',
        buyer_agent_id: 'buyer-123',
        payload: { request: 'audit test', service_type: 'custom_type' }
      });
    expect(createRes.status).toBe(201);
    const contractId = createRes.body.id;

    // 2. Perform escrow with payment header
    const xPaymentHeader = Buffer.from(JSON.stringify({
      payload: {
        authorization: {
          from: '0xBuyerWallet',
          to: '0xProviderWallet',
          value: '10000'
        }
      }
    })).toString('base64');

    const payRes = await request(app)
      .post(`/api/v1/contracts/${contractId}/escrow`)
      .set('X-PAYMENT', xPaymentHeader);

    expect(payRes.status).toBe(200);
    expect(payRes.body.status).toBe('escrowed');
    expect(payRes.body.settled_at).toBeDefined();

    const settlementId = payRes.body.x402_payment_id;
    expect(dbState.settlements[settlementId]).toBeDefined();
    
    // In simulation mode, tx_hash is set to xPaymentHeader
    expect(dbState.settlements[settlementId].tx_hash).toBe(xPaymentHeader);
    expect(dbState.contracts[contractId].settled_at).toBeDefined();
  });
});
