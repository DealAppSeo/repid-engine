process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import express from 'express';
import request from 'supertest';
import faucetRouter from '../src/routes/faucet';

describe('GET /api/v1/faucet/info', () => {
  it('does not dispense', async () => {
    const app = express();
    app.use('/api/v1', faucetRouter);
    const res = await request(app).get('/api/v1/faucet/info');
    expect(res.status).toBe(200);
    expect(res.body.dispenses).toBe(false);
  });
});
