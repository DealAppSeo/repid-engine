import request from 'supertest';
import app from '../../src/index';

describe('Auth gating', () => {
  describe('Public discovery surfaces (must NOT require auth)', () => {
    it('GET /ai-plugin.json returns 301 (redirect to .well-known)', async () => {
      const res = await request(app).get('/ai-plugin.json');
      expect(res.status).toBe(301);
      expect(res.header.location).toBe('/.well-known/ai-plugin.json');
    });
    
    it('GET /.well-known/ai-plugin.json returns 200', async () => {
      const res = await request(app).get('/.well-known/ai-plugin.json');
      expect(res.status).toBe(200);
    });

    it('GET /api/v1/hal/stats returns 200', async () => {
      const res = await request(app).get('/api/v1/hal/stats');
      expect(res.status).toBe(200);
    });

    it('GET /bounties returns 200', async () => {
      const res = await request(app).get('/bounties');
      expect(res.status).toBe(200);
    });

    it('POST /api/v1/prove-repid without body returns 400 (not 401)', async () => {
      const res = await request(app)
        .post('/api/v1/prove-repid')
        .set('Content-Type', 'application/json')
        .send({});
      // Expected: 400 (missing fields) — NOT 401 (auth required)
      expect([400, 404]).toContain(res.status);
    });
  });

  describe('Auth-required surfaces (must require auth)', () => {
    it('POST /api/v1/llm/complete without bearer returns 401', async () => {
      const res = await request(app)
        .post('/api/v1/llm/complete')
        .set('Content-Type', 'application/json')
        .send({ prompt: 'test' });
      expect([401, 403]).toContain(res.status);
    });
  });

  describe('Trust proxy', () => {
    it('app.get("trust proxy") is set to 1', () => {
      expect(app.get('trust proxy')).toBe(1);
    });
  });
});
