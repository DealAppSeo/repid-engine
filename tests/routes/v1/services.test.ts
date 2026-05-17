import request from 'supertest';
import app from '../../../src/index';

jest.mock('../../../src/db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue({ data: { id: 'test-id' }, error: null }),
    maybeSingle: jest.fn().mockResolvedValue({ data: { id: 'test-id' }, error: null })
  }
}));

// Mock authentication
jest.mock('../../../src/middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.apiKey = { key: 'test-key', tier: 'premium' };
    next();
  }
}));

describe('Services Routes', () => {
  it('registers a service', async () => {
    const res = await request(app).post('/api/v1/services').send({
      provider_agent_id: 'test-agent',
      service_type: 'verification',
      service_name: 'Test Service',
      base_price_usdc_raw: 100000
    });
    expect(res.status).toBe(201);
  });

  it('lists services', async () => {
    const res = await request(app).get('/api/v1/services');
    expect(res.status).toBe(200);
  });

  it('gets service categories', async () => {
    const res = await request(app).get('/api/v1/services/categories');
    expect(res.status).toBe(200);
  });
});
