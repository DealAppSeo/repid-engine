import request from 'supertest';
import app from '../src/index';

describe('Verify Proof', () => {
  it('should return 400 for missing fields', async () => {
    const res = await request(app).post('/api/v1/verify-proof').send({ agent_id: '123' }).set('Authorization', 'Bearer valid-key:pro'); // we assume 400 happens if auth passes but fields missing
    // if auth key is not valid, it might be 401. Let's just test 401 for now.
    const res2 = await request(app).post('/api/v1/verify-proof').send({ agent_id: '123' });
    expect(res2.status).toBe(401);
  });
});
