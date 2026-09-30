import express from 'express';
import request from 'supertest';
import { createOnboardUnlockRouter } from '../src/routes/onboard-unlock';

describe('GET /api/v1/onboard/unlock', () => {
  async function get(counted: number) {
    const server = express();
    server.use('/api/v1', createOnboardUnlockRouter(async () => counted));
    return request(server).get('/api/v1/onboard/unlock');
  }

  it('unlocks layer 1 for one receipt and nothing for 0 or 3', async () => {
    const one = await get(1);
    expect(one.status).toBe(200);
    expect(one.body).toEqual({ unlocked: [1] });
    expect(Object.keys(one.body)).toEqual(['unlocked']);

    const zero = await get(0);
    expect(zero.status).toBe(200);
    expect(zero.body).toEqual({ unlocked: [] });

    const three = await get(3);
    expect(three.status).toBe(200);
    expect(three.body).toEqual({ unlocked: [] });
  });
});
