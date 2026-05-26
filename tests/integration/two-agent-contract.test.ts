import request from 'supertest';
import app from '../../src/index';

jest.mock('../../src/db', () => {
  let currentStatus = 'pending';
  const mockSelect = jest.fn().mockReturnThis();
  const mockEq = jest.fn().mockReturnThis();

  return {
    db: {
      from: jest.fn().mockReturnThis(),
      select: mockSelect,
      insert: jest.fn().mockReturnThis(),
      update: jest.fn().mockImplementation((args) => {
        if (args && args.status) {
          currentStatus = args.status;
        }
        const chain = {
          eq: () => chain,
          select: () => chain,
          single: () => Promise.resolve({ data: { id: 'test-id', status: currentStatus }, error: null })
        };
        return chain;
      }),
      eq: mockEq,
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
      delete: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: { id: 'contract-id' }, error: null }),
      maybeSingle: jest.fn().mockImplementation(() => {
        return Promise.resolve({
          data: {
            id: 'test-id',
            status: currentStatus,
            active: true,
            provider_agent_id: 'provider-123',
            min_repid_to_purchase: 100,
            current_repid: 200
          },
          error: null
        });
      }),
      range: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
      upsert: jest.fn().mockReturnThis(),
    }
  };
});

// Mock authentication
jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.apiKey = { key: 'test-key', tier: 'premium' };
    next();
  }
}));

jest.mock('../../src/services/validation-repid-delta', () => ({
  applyServiceFulfilledDeltas: jest.fn(),
  applyServiceSatisfiedDeltas: jest.fn()
}));

describe('Integration: Two Agent Contract', () => {
  it('runs full contract lifecycle', async () => {
    let res = await request(app).post('/api/v1/contracts').send({
      service_id: 'test-service',
      buyer_agent_id: 'buyer-123',
      payload: { request: 'test' }
    });
    expect(res.status).toBe(201);
    
    res = await request(app).post('/api/v1/contracts/test-id/escrow');
    expect(res.status).toBe(200);

    res = await request(app).post('/api/v1/contracts/test-id/fulfill').send({ result: { success: true }});
    if (res.status !== 200) console.error('FULFILL ERROR:', res.text || res.body);
    expect(res.status).toBe(200);

    res = await request(app).post('/api/v1/contracts/test-id/satisfy').send({ satisfaction_score: 0.9 });
    expect(res.status).toBe(200);
  });
});
