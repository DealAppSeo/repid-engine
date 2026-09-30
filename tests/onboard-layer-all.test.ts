import express from 'express';
import request from 'supertest';
import { createOnboardLayerRouter } from '../src/routes/onboard-layer';
import { readOnboardLayer } from '../src/services/onboard-layer';

describe('GET /api/v1/onboard/layer', () => {
  async function get(count: () => Promise<number | 'NOT_CHECKED'>) {
    const server = express();
    server.use('/api/v1', createOnboardLayerRouter(count));
    return request(server).get('/api/v1/onboard/layer');
  }

  it('maps 0 receipts to layer 0, 1 to layer 1, and 3 to layer 3', async () => {
    expect((await get(async () => 0)).body).toEqual({ layer: 0 });
    expect((await get(async () => 1)).body).toEqual({ layer: 1 });
    expect((await get(async () => 3)).body).toEqual({ layer: 3 });
  });

  it('a missing table is NOT_CHECKED and is not layer 0', async () => {
    const missing = await readOnboardLayer(async () => {
      throw new Error('relation does not exist');
    });
    expect(missing).toEqual({ layer: 'NOT_CHECKED' });
    expect(missing.layer).not.toBe(0);
    const res = await get(async () => {
      throw new Error('relation does not exist');
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ layer: 'NOT_CHECKED' });
    expect(res.body.layer).not.toBe(0);
  });
});
