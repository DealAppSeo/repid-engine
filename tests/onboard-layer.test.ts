import express from 'express';
import request from 'supertest';
import { createOnboardLayerRouter } from '../src/routes/onboard-layer';
import { readOnboardLayer } from '../src/services/onboard-layer';

describe('GET /api/v1/onboard/layer', () => {
  it('returns layer 0 when receipts counted is 0', async () => {
    const server = express();
    server.use('/api/v1', createOnboardLayerRouter(async () => 0));
    const res = await request(server).get('/api/v1/onboard/layer');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ layer: 0 });
    expect(await readOnboardLayer(async () => 0)).toEqual({ layer: 0 });
  });
});
