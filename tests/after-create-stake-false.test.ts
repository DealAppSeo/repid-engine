process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

import express from 'express';
import request from 'supertest';
import afterCreateRouter from '../src/routes/after-create';

describe('GET /api/v1/after-create can_stake', () => {
  const saved = process.env.REAL_STAKING_ENABLED;

  afterEach(() => {
    if (saved === undefined) delete process.env.REAL_STAKING_ENABLED;
    else process.env.REAL_STAKING_ENABLED = saved;
  });

  it('stays false when the flag is the string true', async () => {
    process.env.REAL_STAKING_ENABLED = 'true';
    const app = express();
    app.use('/api/v1', afterCreateRouter);
    const res = await request(app).get('/api/v1/after-create');
    expect(res.status).toBe(200);
    expect(res.body.can_verify).toBe(true);
    expect(res.body.can_stake).toBe(false);
    expect(res.body.applied).toBe(false);
  });
});
