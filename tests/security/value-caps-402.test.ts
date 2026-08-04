import request from 'supertest';
import app from '../../src/index';
import { db } from '../../src/db';

// Mock database calls
jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
  }
}));

// Mock authentication middleware to bypass auth issues in unit tests.
//
// `agent_id` added 2026-08-04: /escrow now requires a caller bound to an agent that
// is a PARTY to the contract. Setting `apiKey` alone is the shared-REPID_API_KEYS
// shape, which is now refused with 403 before the cap checks are reached.
// 'buyer-456' is the buyer on this suite's service_contracts fixtures.
jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.apiKey = { key: 'test-key', tier: 'premium' };
    req.agent_id = 'buyer-456';
    next();
  }
}));

describe('Global USDC Value Caps (Phase 1)', () => {
  const originalEnvPerContract = process.env.VALUE_CAP_PER_CONTRACT_USDC;
  const originalEnvDaily = process.env.VALUE_CAP_DAILY_USDC;
  const originalEnforcement = process.env.X402_ENFORCEMENT_ENABLED;

  beforeAll(() => {
    process.env.X402_ENFORCEMENT_ENABLED = 'true';
  });

  afterAll(() => {
    process.env.VALUE_CAP_PER_CONTRACT_USDC = originalEnvPerContract;
    process.env.VALUE_CAP_DAILY_USDC = originalEnvDaily;
    process.env.X402_ENFORCEMENT_ENABLED = originalEnforcement;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Default values per spec
    process.env.VALUE_CAP_PER_CONTRACT_USDC = '10'; // 10 USDC
    process.env.VALUE_CAP_DAILY_USDC = '100'; // 100 USDC
  });

  const mockDbCalls = (opts: {
    servicePrice: number;
    settlementsToday: { amount: number }[];
    contractStatus: string;
  }) => {
    jest.spyOn(db, 'from').mockImplementation((table: string) => {
      if (table === 'agent_services') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: {
              id: 'service-123',
              active: true,
              provider_agent_id: 'provider-123',
              base_price_usdc_raw: opts.servicePrice,
              min_repid_to_purchase: 0
            },
            error: null
          })
        } as any;
      }
      if (table === 'repid_agents') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: { id: 'agent-123', current_repid: 2000, wallet_address: '0xProviderWallet' },
            error: null
          }),
          single: jest.fn().mockResolvedValue({
            data: { id: 'agent-123', current_repid: 2000, wallet_address: '0xProviderWallet' },
            error: null
          })
        } as any;
      }
      if (table === 'service_contracts') {
        return {
          select: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: {
              id: 'contract-123',
              status: opts.contractStatus,
              agreed_price_usdc_raw: opts.servicePrice,
              provider_agent_id: 'provider-123',
              buyer_agent_id: 'buyer-456'
            },
            error: null
          }),
          insert: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: { id: 'contract-123', agreed_price_usdc_raw: opts.servicePrice, status: 'pending' },
            error: null
          })
        } as any;
      }
      if (table === 'x402_settlements') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: jest.fn().mockResolvedValue({
            data: null, // No existing duplicate payment/settlement
            error: null
          }),
          gte: jest.fn().mockReturnThis(),
          lte: jest.fn().mockResolvedValue({
            data: opts.settlementsToday,
            error: null
          }),
          insert: jest.fn().mockReturnThis(),
          single: jest.fn().mockResolvedValue({
            data: { id: 'settlement-123' },
            error: null
          })
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

  describe('Contract Creation (/create)', () => {
    it('allows contract creation when under caps', async () => {
      mockDbCalls({
        servicePrice: 5_000_000, // 5 USDC
        settlementsToday: [],
        contractStatus: 'pending'
      });

      const res = await request(app)
        .post('/api/v1/contracts')
        .send({
          service_id: 'service-123',
          buyer_agent_id: 'buyer-456',
          payload: { task: 'test' }
        });

      if (res.status === 500) {
        console.error("DEBUG INTERNAL ERROR:", res.status, res.text);
      }
      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
    });

    it('returns 402 when contract price exceeds per-contract cap', async () => {
      mockDbCalls({
        servicePrice: 12_000_000, // 12 USDC (cap is 10)
        settlementsToday: [],
        contractStatus: 'pending'
      });

      const res = await request(app)
        .post('/api/v1/contracts')
        .send({
          service_id: 'service-123',
          buyer_agent_id: 'buyer-456',
          payload: { task: 'test' }
        });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('per_contract_cap_exceeded');
      expect(res.body.cap).toBe(10_000_000);
      expect(res.body.requested).toBe(12_000_000);
    });

    it('returns 402 when cumulative daily volume is exceeded', async () => {
      mockDbCalls({
        servicePrice: 6_000_000, // 6 USDC
        settlementsToday: [
          { amount: 50_000_000 }, // 50 USDC
          { amount: 45_000_000 }  // 45 USDC -> Total 95 USDC + 6 USDC = 101 USDC (cap is 100)
        ],
        contractStatus: 'pending'
      });

      const res = await request(app)
        .post('/api/v1/contracts')
        .send({
          service_id: 'service-123',
          buyer_agent_id: 'buyer-456',
          payload: { task: 'test' }
        });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('daily_cumulative_cap_exceeded');
      expect(res.body.cap).toBe(100_000_000);
      expect(res.body.requested).toBe(101_000_000);
    });
  });

  describe('Contract Escrow (/escrow)', () => {
    it('allows escrow when under caps', async () => {
      mockDbCalls({
        servicePrice: 5_000_000, // 5 USDC
        settlementsToday: [],
        contractStatus: 'pending'
      });

      const res = await request(app)
        .post('/api/v1/contracts/contract-123/escrow')
        .set('X-PAYMENT', 'mock-payment-header');

      // It will try to update contract to escrowed and return it, status should not be 402
      expect(res.status).not.toBe(402);
    });

    it('returns 402 when contract price exceeds per-contract cap during escrow', async () => {
      mockDbCalls({
        servicePrice: 15_000_000, // 15 USDC (cap is 10)
        settlementsToday: [],
        contractStatus: 'pending'
      });

      const res = await request(app)
        .post('/api/v1/contracts/contract-123/escrow')
        .set('X-PAYMENT', 'mock-payment-header');

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('per_contract_cap_exceeded');
      expect(res.body.cap).toBe(10_000_000);
      expect(res.body.requested).toBe(15_000_000);
    });

    it('returns 402 when cumulative daily volume is exceeded during escrow', async () => {
      mockDbCalls({
        servicePrice: 8_000_000, // 8 USDC
        settlementsToday: [
          { amount: 60_000_000 }, // 60 USDC
          { amount: 35_000_000 }  // 35 USDC -> Total 95 USDC + 8 USDC = 103 USDC (cap is 100)
        ],
        contractStatus: 'pending'
      });

      const res = await request(app)
        .post('/api/v1/contracts/contract-123/escrow')
        .set('X-PAYMENT', 'mock-payment-header');

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('daily_cumulative_cap_exceeded');
      expect(res.body.cap).toBe(100_000_000);
      expect(res.body.requested).toBe(103_000_000);
    });
  });

  describe('UTC Midnight Reset', () => {
    it('correctly maps dates to UTC midnight splits', () => {
      const now = new Date('2026-05-25T23:59:59.999Z');
      const todayString = now.toISOString().split('T')[0];
      expect(todayString).toBe('2026-05-25');

      const nextTick = new Date(now.getTime() + 1); // 1ms later
      const nextTickString = nextTick.toISOString().split('T')[0];
      expect(nextTickString).toBe('2026-05-26');
    });
  });

  describe('Missing or Undefined Env Vars Defaults', () => {
    beforeEach(() => {
      delete process.env.VALUE_CAP_PER_CONTRACT_USDC;
      delete process.env.VALUE_CAP_DAILY_USDC;
    });

    it('defaults to 10 USDC per-contract cap if env var is missing', async () => {
      mockDbCalls({
        servicePrice: 12_000_000, // 12 USDC (cap should default to 10)
        settlementsToday: [],
        contractStatus: 'pending'
      });

      const res = await request(app)
        .post('/api/v1/contracts')
        .send({
          service_id: 'service-123',
          buyer_agent_id: 'buyer-456',
          payload: { task: 'test' }
        });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('per_contract_cap_exceeded');
      expect(res.body.cap).toBe(10_000_000);
      expect(res.body.requested).toBe(12_000_000);
    });

    it('defaults to 100 USDC daily cap if env var is missing', async () => {
      mockDbCalls({
        servicePrice: 6_000_000, // 6 USDC
        settlementsToday: [
          { amount: 95_000_000 }  // 95 USDC -> Total 101 USDC (cap should default to 100)
        ],
        contractStatus: 'pending'
      });

      const res = await request(app)
        .post('/api/v1/contracts')
        .send({
          service_id: 'service-123',
          buyer_agent_id: 'buyer-456',
          payload: { task: 'test' }
        });

      expect(res.status).toBe(402);
      expect(res.body.error).toBe('daily_cumulative_cap_exceeded');
      expect(res.body.cap).toBe(100_000_000);
      expect(res.body.requested).toBe(101_000_000);
    });
  });

  describe('VALUE_CAP_ENFORCEMENT Configurable Modes', () => {
    afterEach(() => {
      delete process.env.VALUE_CAP_ENFORCEMENT;
    });

    it('bypasses checks completely when VALUE_CAP_ENFORCEMENT=off', async () => {
      process.env.VALUE_CAP_ENFORCEMENT = 'off';
      mockDbCalls({
        servicePrice: 15_000_000, // 15 USDC (exceeds cap of 10)
        settlementsToday: [],
        contractStatus: 'pending'
      });

      const res = await request(app)
        .post('/api/v1/contracts')
        .send({
          service_id: 'service-123',
          buyer_agent_id: 'buyer-456',
          payload: { task: 'test' }
        });

      expect(res.status).toBe(201);
    });

    it('logs warning but allows when VALUE_CAP_ENFORCEMENT=warn', async () => {
      process.env.VALUE_CAP_ENFORCEMENT = 'warn';
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      mockDbCalls({
        servicePrice: 15_000_000, // 15 USDC (exceeds cap of 10)
        settlementsToday: [],
        contractStatus: 'pending'
      });

      const res = await request(app)
        .post('/api/v1/contracts')
        .send({
          service_id: 'service-123',
          buyer_agent_id: 'buyer-456',
          payload: { task: 'test' }
        });

      expect(res.status).toBe(201);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[VALUE_CAP_WARNING]'));
      warnSpy.mockRestore();
    });
  });
});
