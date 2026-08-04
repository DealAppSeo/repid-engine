import request from 'supertest';
import app from '../../../src/index';
import { db } from '../../../src/db';

jest.mock('../../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: 'contract-id' }, error: null }),
    maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'test-id', active: true, provider_agent_id: 'provider-123', min_repid_to_purchase: 100, current_repid: 200 }, error: null }),
    range: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockResolvedValue({ data: [], error: null }),
    rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
    upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
  }
}));

// Mock authentication.
//
// CHANGED 2026-08-04: this mock used to set `apiKey` ONLY, which is precisely the
// shared-`REPID_API_KEYS`-key shape — authenticated, but with no bound agent
// identity. Every escrow test below therefore asserted that an unidentified caller
// could escrow someone else's contract, i.e. the suite encoded the authorization
// hole as expected behavior. `/escrow` now refuses that caller, so the mock supplies
// a bound identity and the contract rows name it as the buyer.
//
// The refusal itself is NOT tested here — it is tested against a deliberately
// unbound caller in tests/contracts-party-routes.test.ts, so that this suite keeps
// testing escrow's payment logic and that one keeps testing who may reach it.
jest.mock('../../../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.apiKey = { key: 'test-key', tier: 'premium' };
    req.agent_id = 'buyer-123';
    next();
  }
}));

describe('Contracts Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a contract', async () => {
    jest.spyOn(db, 'from').mockReturnValue({
      select: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'test-service', active: true, min_repid_to_purchase: 100, base_price_usdc_raw: 10000 }, error: null }),
      single: jest.fn().mockResolvedValue({ data: { id: 'contract-id' }, error: null }),
      gte: jest.fn().mockReturnThis(),
      lte: jest.fn().mockResolvedValue({ data: [], error: null }),
      upsert: jest.fn().mockResolvedValue({ data: null, error: null })
    } as any);

    const res = await request(app).post('/api/v1/contracts').send({
      service_id: 'test-service',
      buyer_agent_id: 'buyer-123',
      payload: { request: 'test' }
    });
    if (res.status !== 201) console.log('CREATE CONTRACT ERROR:', res.text);
    expect(res.status).toBe(201);
  });

  describe('escrow with enforcement OFF', () => {
    beforeAll(() => {
      process.env.X402_ENFORCEMENT_ENABLED = 'false';
    });

    it('escrows a contract without payment (legacy behavior)', async () => {
      jest.spyOn(db, 'from').mockReturnValue({
        select: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        // buyer_agent_id matches the bound caller in the auth mock — without it
        // the party guard refuses before the legacy branch is ever reached.
        maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'test-id', status: 'pending', buyer_agent_id: 'buyer-123', provider_agent_id: 'provider-123' }, error: null }),
        single: jest.fn().mockResolvedValue({ data: { id: 'test-id', status: 'escrowed' }, error: null }),
        gte: jest.fn().mockReturnThis(),
        lte: jest.fn().mockResolvedValue({ data: [], error: null }),
        upsert: jest.fn().mockResolvedValue({ data: null, error: null })
      } as any);

      const res = await request(app).post('/api/v1/contracts/test-id/escrow');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('escrowed');
    });
  });

  describe('escrow with enforcement ON', () => {
    beforeAll(() => {
      process.env.X402_ENFORCEMENT_ENABLED = 'true';
    });

    afterAll(() => {
      process.env.X402_ENFORCEMENT_ENABLED = 'false';
    });

    const mockDbForEscrow = (opts: { contractStatus: string; existingSettlement: any; insertMock?: any }) => {
      jest.spyOn(db, 'from').mockImplementation((table: string) => {
        if (table === 'service_contracts') {
          return {
            select: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({
              data: {
                id: 'test-id',
                status: opts.contractStatus,
                agreed_price_usdc_raw: 10000,
                // buyer_agent_id added 2026-08-04: the party guard reads it, and
                // the bound caller in the auth mock is the buyer.
                buyer_agent_id: 'buyer-123',
                provider_agent_id: 'provider-123',
                wallet_address: '0xProviderWallet'
              },
              error: null
            }),
            single: jest.fn().mockResolvedValue({
              data: {
                id: 'test-id',
                status: 'escrowed',
                x402_payment_id: 'settlement-uuid'
              },
              error: null
            })
          } as any;
        } else if (table === 'repid_agents') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: { wallet_address: '0xProviderWallet' }, error: null }),
          } as any;
        } else if (table === 'x402_settlements') {
          return {
            select: jest.fn().mockReturnThis(),
            eq: jest.fn().mockReturnThis(),
            maybeSingle: jest.fn().mockResolvedValue({ data: opts.existingSettlement, error: null }),
            insert: opts.insertMock || jest.fn().mockReturnThis(),
            single: jest.fn().mockResolvedValue({ data: { id: 'settlement-uuid' }, error: null }),
            gte: jest.fn().mockReturnThis(),
            lte: jest.fn().mockResolvedValue({ data: [], error: null })
          } as any;
        }
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
          upsert: jest.fn().mockResolvedValue({ data: null, error: null })
        } as any;
      });
    };

    it('returns 402 payment required if X-PAYMENT header is missing', async () => {
      mockDbForEscrow({ contractStatus: 'pending', existingSettlement: null });

      const res = await request(app).post('/api/v1/contracts/test-id/escrow');
      expect(res.status).toBe(402);
      expect(res.body.error).toBe('Payment required');
      expect(res.body.accepts).toBeDefined();
    });

    it('returns 409 conflict if contract is already escrowed', async () => {
      mockDbForEscrow({ contractStatus: 'escrowed', existingSettlement: null });

      const res = await request(app).post('/api/v1/contracts/test-id/escrow');
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('wrong_status');
    });

    it('accepts valid X-PAYMENT and transitions contract to escrowed', async () => {
      const mockInsert = jest.fn().mockReturnThis();
      mockDbForEscrow({
        contractStatus: 'pending',
        existingSettlement: null,
        insertMock: mockInsert
      });

      const res = await request(app)
        .post('/api/v1/contracts/test-id/escrow')
        .set('X-PAYMENT', Buffer.from(JSON.stringify({ txHash: '0xMockTxHash' })).toString('base64'));

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('escrowed');
      expect(res.body.x402_payment_id).toBe('settlement-uuid');
      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
        tip_id: 'contract_test-id',
        amount: 10000,
        asset: 'USDC',
        idempotency_key: 'test-id'
      }));
    });
  });
});
