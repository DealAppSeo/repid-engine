import request from 'supertest';
import app from '../../src/index';
import { db } from '../../src/db';

// Mock authentication
jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.apiKey = { key: 'test-key', tier: 'premium' };
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

describe('x402 End-to-End Contract Economic Loop', () => {
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

    // Set up mock DB router to redirect queries to our in-memory dbState
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

  test('full economic loop: payment -> escrow -> settle', async () => {
    // Enable enforcement
    process.env.X402_ENFORCEMENT_ENABLED = 'true';

    // 1. Create a contract first
    const createRes = await request(app)
      .post('/api/v1/contracts')
      .send({
        service_id: 'service-123',
        buyer_agent_id: 'buyer-123',
        payload: { request: 'test request', service_type: 'custom_type' }
      });
    expect(createRes.status).toBe(201);
    const contractId = createRes.body.id;
    expect(contractId).toBeDefined();
    expect(dbState.contracts[contractId]).toBeDefined();

    // 2. Escrow attempt WITHOUT payment header -> 402 challenge
    const challengeRes = await request(app)
      .post(`/api/v1/contracts/${contractId}/escrow`);
    expect(challengeRes.status).toBe(402);
    expect(challengeRes.body.error).toBe('Payment required');
    expect(challengeRes.body.accepts).toBeDefined();
    expect(challengeRes.body.accepts[0].resource).toBe(`/api/v1/contracts/${contractId}/escrow`);
    expect(challengeRes.body.accepts[0].payTo).toBe('0xProviderWallet');
    expect(challengeRes.body.accepts[0].maxAmountRequired).toBe('10000');

    // 3. Escrow attempt WITH valid payment header (simulated mode) -> 200 OK
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
    
    console.log('PAY RES BODY:', payRes.body);

    expect(payRes.status).toBe(200);
    expect(payRes.body.status).toBe('escrowed');
    expect(payRes.body.x402_payment_id).toBeDefined();

    const settlementId = payRes.body.x402_payment_id;
    console.log('SETTLEMENT ID:', settlementId);
    console.log('DB STATE SETTLEMENTS:', dbState.settlements);
    expect(dbState.settlements[settlementId]).toBeDefined();
    expect(dbState.settlements[settlementId].tip_id).toBe(`contract_${contractId}`);
    expect(dbState.settlements[settlementId].idempotency_key).toBe(contractId);
    expect(dbState.settlements[settlementId].amount).toBe(10000);
    expect(dbState.settlements[settlementId].is_simulated).toBe(true);

    // 4. Idempotency: replay the same request -> returns same contract immediately without creating new settlement
    const replayRes = await request(app)
      .post(`/api/v1/contracts/${contractId}/escrow`)
      .set('X-PAYMENT', xPaymentHeader);

    console.log('REPLAY RES BODY:', replayRes.body);

    expect(replayRes.status).toBe(200);
    expect(replayRes.body.x402_payment_id).toBe(settlementId);
    expect(Object.keys(dbState.settlements).length).toBe(1); // No new settlements created
  });

  test('legacy mode backward compatibility', async () => {
    process.env.X402_ENFORCEMENT_ENABLED = 'false';

    // 1. Create contract
    const createRes = await request(app)
      .post('/api/v1/contracts')
      .send({
        service_id: 'service-123',
        buyer_agent_id: 'buyer-123',
        payload: { request: 'test legacy', service_type: 'custom_type' }
      });
    const contractId = createRes.body.id;

    // 2. Escrow WITHOUT payment -> should succeed immediately (legacy behavior)
    const escrowRes = await request(app)
      .post(`/api/v1/contracts/${contractId}/escrow`);
    expect(escrowRes.status).toBe(200);
    expect(escrowRes.body.status).toBe('escrowed');
    expect(escrowRes.body.x402_payment_id).toBeNull();
  });

  afterAll(async () => {
    // Teardown: close pg pool and redis client
    const { closePgPool } = require('../../src/db/direct-pg');
    const { closeRedisClient } = require('../../src/clients/redis-client');
    await closePgPool();
    await closeRedisClient();
  });
});
