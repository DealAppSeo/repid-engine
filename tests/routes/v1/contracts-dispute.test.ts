import request from 'supertest';
import app from '../../../src/index';

const mockSelect = jest.fn().mockReturnThis();
const mockEq = jest.fn().mockReturnThis();
const mockMaybeSingle = jest.fn().mockResolvedValue({ data: { id: 'test-id', active: true, provider_agent_id: 'provider-123', min_repid_to_purchase: 100, current_repid: 200 }, error: null });

jest.mock('../../../src/db', () => ({
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
jest.mock('../../../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.apiKey = { key: 'test-key', tier: 'premium' };
    next();
  }
}));

describe('Contracts Dispute Routes', () => {
  it('disputes a contract', async () => {
    const res = await request(app).post('/api/v1/contracts/test-id/dispute').send({
      reason: 'provider failed to deliver',
      evidence: {}
    });
    expect(res.status).toBe(200);
  });

  it('resolves a contract', async () => {
    const res = await request(app).post('/api/v1/contracts/test-id/resolve').send({
      dispute_verdict: 'provider_at_fault'
    });
    expect(res.status).toBe(200);
  });
});
