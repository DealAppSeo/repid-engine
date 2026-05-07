import request from 'supertest';
import express from 'express';
import { adminCapsRouter } from '../admin-caps';
import { db } from '../../db';

const app = express();
app.use(express.json());
app.use('/api/v1/admin/caps', adminCapsRouter);

jest.mock('../../db', () => ({
  db: {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    order: jest.fn().mockResolvedValue({ data: [{ provider: 'groq' }], error: null }),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockResolvedValue({ error: null }),
    single: jest.fn().mockResolvedValue({ data: { provider: 'groq' }, error: null })
  }
}));

describe('Admin Caps', () => {
  beforeEach(() => {
    process.env.ADMIN_KEY = 'secret';
    jest.clearAllMocks();
  });

  it('GET /admin/caps without admin key -> 401', async () => {
    const res = await request(app).get('/api/v1/admin/caps');
    expect(res.status).toBe(401);
  });

  it('GET with valid key -> 200', async () => {
    const res = await request(app).get('/api/v1/admin/caps').set('x-admin-key', 'secret');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ provider: 'groq' }]);
  });

  it('POST updates row', async () => {
    const res = await request(app).post('/api/v1/admin/caps/groq').set('x-admin-key', 'secret').send({ monthly_limit_usd: 10 });
    expect(res.status).toBe(200);
    expect(db.from('llm_provider_caps').update).toHaveBeenCalledWith(expect.objectContaining({ monthly_limit_usd: 10 }));
  });

  it('Wrong key format -> 401', async () => {
    const res = await request(app).post('/api/v1/admin/caps/groq').set('x-admin-key', 'wrong');
    expect(res.status).toBe(401);
  });
});
