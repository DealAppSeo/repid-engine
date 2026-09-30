import express from 'express';
import request from 'supertest';
import { createOnboardLayerRouter } from '../src/routes/onboard-layer';
import { readOnboardLayer } from '../src/services/onboard-layer';

describe('GET /api/v1/onboard/layer counts', () => {
  it('maps 0, 1, and 3 to those layers and a missing table to NOT_CHECKED', async () => {
    for (const counted of [0, 1, 3] as const) {
      const server = express();
      server.use('/api/v1', createOnboardLayerRouter(async () => counted));
      const res = await request(server).get('/api/v1/onboard/layer');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ layer: counted });
      expect(await readOnboardLayer(async () => counted)).toEqual({ layer: counted });
    }

    const missing = await readOnboardLayer(async () => {
      throw new Error('relation does not exist');
    });
    expect(missing).toEqual({ layer: 'NOT_CHECKED' });
    expect(missing.layer).not.toBe(0);

    const server = express();
    server.use('/api/v1', createOnboardLayerRouter());
    const res = await request(server).get('/api/v1/onboard/layer');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ layer: 'NOT_CHECKED' });
    expect(res.body.layer).not.toBe(0);
  });
});
