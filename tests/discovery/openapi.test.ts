import request from 'supertest';
import app from '../../src/index';

describe('Discovery Routes', () => {
  it('GET /openapi.json returns 200 and valid JSON', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.header['content-type']).toMatch(/json/);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths).length).toBeGreaterThanOrEqual(5);
  });

  it('GET /.well-known/ai-plugin.json returns 200', async () => {
    const res = await request(app).get('/.well-known/ai-plugin.json');
    expect(res.status).toBe(200);
    expect(res.body.name_for_model).toBe('hyperdag_repid');
  });
});
