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

// Mock authentication
jest.mock('../../../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.apiKey = { key: 'test-key', tier: 'premium' };
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
        maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'test-id', status: 'pending' }, error: null }),
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
            // Must be a REAL EVM address: the 2026-07-30 burn-trap guard
            // validates payTo with ethers.isAddress and refuses otherwise.
            maybeSingle: jest.fn().mockResolvedValue({ data: { wallet_address: '0xdf6b8215D193b11B4903d223729c3CF7A6de271d' }, error: null }),
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
