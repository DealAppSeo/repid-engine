import express from 'express';
import request from 'supertest';
import { createOnboardLayerRouter } from '../src/routes/onboard-layer';
import { readOnboardLayer } from '../src/services/onboard-layer';

describe('onboard layer from a counted receipt total', () => {
  async function get(count: () => Promise<number | 'NOT_CHECKED'>) {
    const server = express();
    server.use('/api/v1', createOnboardLayerRouter(count));
    return request(server).get('/api/v1/onboard/layer');
  }

  it('maps counted 1 to layer 1 and counted 3 to layer 3', async () => {
    const one = await get(async () => 1);
    const three = await get(async () => 3);
    expect(one.status).toBe(200);
    expect(one.body).toEqual({ layer: 1 });
    expect(three.body).toEqual({ layer: 3 });
  });

  it('a missing table is NOT_CHECKED and is not layer 0', async () => {
    const missing = await readOnboardLayer(async () => {
      throw new Error('relation hyperdag_receipts does not exist');
    });
    expect(missing).toEqual({ layer: 'NOT_CHECKED' });
    expect(missing.layer).not.toBe(0);
    const res = await get(async () => {
      throw new Error('relation hyperdag_receipts does not exist');
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ layer: 'NOT_CHECKED' });
    expect(res.body.layer).not.toBe(0);
  });
});
