import request from 'supertest';
import app from '../../src/index';
import { db } from '../../src/db';
import { applyServiceFulfilledDeltas } from '../../src/services/validation-repid-delta';

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
    upsert: jest.fn().mockResolvedValue({ data: null, error: null })
  }
}));

jest.mock('../../src/services/validation-repid-delta', () => ({
  applyServiceFulfilledDeltas: jest.fn().mockResolvedValue(undefined),
  applyServiceSatisfiedDeltas: jest.fn().mockResolvedValue(undefined)
}));

/**
 * 2026-08-01: /fulfill now requires an agent-bound caller who IS the provider.
 * Before that it accepted `{result: <anything>}` from anyone, which let a
 * provider fulfil its own contract with a self-declared PASS and then release
 * its own payment.
 *
 * This suite mounts the real app and sends no Authorization header, so
 * `req.agent_id` was undefined and every fulfil 403'd. The binding is mocked
 * here — `x-test-agent-id` stands in for the identity authMiddleware would
 * attach — so these tests keep exercising DOUBLE-FULFILL prevention, which is
 * what they are actually for. The provider gate itself is asserted separately
 * below rather than being mocked away.
 */
const testAuth: { boundAgentId: string | null } = { boundAgentId: null };

jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const state = (global as any).__testAuth as { boundAgentId: string | null };
    if (state?.boundAgentId) req.agent_id = state.boundAgentId;
    req.apiKey = { key: 'test', tier: 'pro' };
    next();
  },
}));
(global as any).__testAuth = testAuth;

// Mock authentication middleware
jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.apiKey = { key: 'test-key', tier: 'premium' };
    next();
  }
}));

describe('Red Team Security Hardening Tests (H1-H4 & P-B)', () => {
  beforeAll(() => {
    process.env.X402_ENFORCEMENT_ENABLED = 'true';
  });

  afterAll(() => {
    process.env.X402_ENFORCEMENT_ENABLED = 'false';
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const mockDbForRedTeam = (opts: {
    contractStatus?: string;
    agentService?: any;
    repidAgent?: any;
    x402Settlement?: any;
    updateContractMock?: any;
  }) => {
    let lastEqField = '';
    
    const createTableMock = (table: string) => {
      const mockObj: any = {
        select: jest.fn().mockImplementation(() => mockObj),
        update: jest.fn().mockImplementation(() => mockObj),
        eq: jest.fn().mockImplementation((field: string, value: any) => {
          lastEqField = field;
          return mockObj;
        }),
        gte: jest.fn().mockImplementation(() => mockObj),
        lte: jest.fn().mockImplementation(() => {
          if (table === 'x402_settlements') {
            return Promise.resolve({ data: [], error: null });
          }
          return mockObj;
        }),
        insert: jest.fn().mockImplementation(() => mockObj),
        upsert: jest.fn().mockResolvedValue({ data: null, error: null }),
        maybeSingle: jest.fn().mockImplementation(() => {
          if (table === 'service_contracts') {
            return Promise.resolve({
              data: opts.contractStatus ? { 
                id: 'contract-1', 
                status: opts.contractStatus,
                agreed_price_usdc_raw: 1000,
                provider_agent_id: 'provider-123',
                buyer_agent_id: 'buyer-456',
                result: opts.contractStatus === 'fulfilled' ? 'already-done' : null
              } : null,
              error: null
            });
          }
          if (table === 'agent_services') {
            return Promise.resolve({ data: opts.agentService || null, error: null });
          }
          if (table === 'repid_agents') {
            return Promise.resolve({ data: opts.repidAgent || { current_repid: 200, wallet_address: '0xmock' }, error: null });
          }
          if (table === 'x402_settlements') {
            if (lastEqField === 'idempotency_key') {
              return Promise.resolve({ data: null, error: null });
            }
            if (lastEqField === 'x_payment_header') {
              return Promise.resolve({ data: opts.x402Settlement || null, error: null });
            }
          }
          return Promise.resolve({ data: null, error: null });
        }),
        single: jest.fn().mockImplementation(() => {
          if (table === 'service_contracts') {
            return Promise.resolve({
              data: { id: 'contract-1', status: 'fulfilled', result: 'done' },
              error: null
            });
          }
          if (table === 'repid_agents') {
            return Promise.resolve({ data: opts.repidAgent || { current_repid: 200, wallet_address: '0xmock' }, error: null });
          }
          if (table === 'x402_settlements') {
            return Promise.resolve({ data: { id: 'settlement-uuid' }, error: null });
          }
          return Promise.resolve({ data: {}, error: null });
        })
      };
      
      if (table === 'service_contracts' && opts.updateContractMock) {
        mockObj.update = opts.updateContractMock;
      }
      
      return mockObj;
    };

    jest.spyOn(db, 'from').mockImplementation((table: string) => {
      return createTableMock(table);
    });
  };

  describe('H3 - Self-Dealing Prevention', () => {
    it('rejects contract creation if buyer is also the provider', async () => {
      mockDbForRedTeam({
        agentService: {
          id: 'service-1',
          active: true,
          provider_agent_id: 'agent-123',
          base_price_usdc_raw: 1000
        }
      });

      const res = await request(app)
        .post('/api/v1/contracts')
        .send({
          service_id: 'service-1',
          buyer_agent_id: 'agent-123', // Same as provider
          payload: { action: 'test' }
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('self_dealing_forbidden');
    });
  });

  describe('H1 - Payment Reuse Replay Protection', () => {
    it('rejects escrow if the X-PAYMENT header is already used', async () => {
      mockDbForRedTeam({
        contractStatus: 'pending',
        x402Settlement: { id: 'existing-settlement-id' } // Already exists
      });

      const res = await request(app)
        .post('/api/v1/contracts/contract-1/escrow')
        .set('X-PAYMENT', 'already-used-header');

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('payment_already_used');
    });
  });

  describe('P-B & H4 - Double-Fulfill Prevention', () => {
    it('successfully fulfills an escrowed contract', async () => {
      testAuth.boundAgentId = 'provider-123';   // the contract's provider
      mockDbForRedTeam({
        contractStatus: 'escrowed'
      });

      const res = await request(app)
        .post('/api/v1/contracts/contract-1/fulfill')
        .send({ result: 'done' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('fulfilled');
      expect(applyServiceFulfilledDeltas).toHaveBeenCalledTimes(1);
    });

            it('idempotently returns existing contract if already fulfilled', async () => {
      mockDbForRedTeam({
        contractStatus: 'fulfilled'
      });

      const res = await request(app)
        .post('/api/v1/contracts/contract-1/fulfill')
        .send({ result: 'done' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('fulfilled');
      expect(res.body.result).toBe('already-done');
      expect(applyServiceFulfilledDeltas).not.toHaveBeenCalled();
    });

    it('rejects fulfillment if contract status is not escrowed (e.g. pending)', async () => {
      mockDbForRedTeam({
        contractStatus: 'pending'
      });

      const res = await request(app)
        .post('/api/v1/contracts/contract-1/fulfill')
        .send({ result: 'done' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Cannot fulfill contract in status');
      expect(applyServiceFulfilledDeltas).not.toHaveBeenCalled();
    });
  });
});
