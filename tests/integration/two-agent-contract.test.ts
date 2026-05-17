import request from 'supertest';
import app from '../../src/index';

const mockSelect = jest.fn().mockReturnThis();
const mockEq = jest.fn().mockReturnThis();
const mockMaybeSingle = jest.fn().mockResolvedValue({ data: { id: 'test-id', active: true, provider_agent_id: 'provider-123', min_repid_to_purchase: 100, current_repid: 200 }, error: null });

jest.mock('../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: mockSelect,
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: mockEq,
    single: jest.fn().mockResolvedValue({ data: { id: 'contract-id' }, error: null }),
    maybeSingle: mockMaybeSingle,
    range: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
  }
}));

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
    expect(res.status).toBe(200);

    res = await request(app).post('/api/v1/contracts/test-id/satisfy').send({ satisfaction_score: 0.9 });
    expect(res.status).toBe(200);
  });
});
