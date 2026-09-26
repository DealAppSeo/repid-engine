import express from 'express';
import request from 'supertest';
import joinKitRouter, { joinKit } from '../src/routes/join-kit';

describe('GET /api/v1/join-kit', () => {
  it('names the six doors and keeps can_stake false', async () => {
    const app = express();
    app.use('/api/v1', joinKitRouter);
    const res = await request(app).get('/api/v1/join-kit');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      verify: '/api/v1/repid/verify',
      status: '/readiness',
      repid: '/api/v1/repid/:agentId',
      proof: '/api/v1/proof/verify',
      honesty_a: '/api/v1/hal/honesty-a',
      after_create: '/api/v1/after-create',
      can_stake: false,
    });
    expect(joinKit().can_stake).toBe(false);
  });
});
