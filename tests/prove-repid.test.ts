import request from 'supertest';
import app from '../src/index';

describe('Prove RepID', () => {
  it('should return 401 without auth', async () => {
    const res = await request(app).post('/api/v1/prove-repid').send({ agent_id: '123', requester_pubkey: 'pub', requested_tier: 'postcard' });
    expect(res.status).toBe(401);
  });
});
