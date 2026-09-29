process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

let inserts = 0;

jest.mock('../src/db', () => {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const name of ['select', 'eq', 'ilike', 'neq', 'in', 'gte', 'order', 'limit', 'upsert']) {
    chain[name] = self;
  }
  chain.maybeSingle = async () => ({ data: null, error: null });
  chain.single = async () => ({ data: null, error: null });
  chain.insert = () => {
    inserts += 1;
    return Promise.resolve({ data: null, error: null });
  };
  return { db: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});

import express from 'express';
import request from 'supertest';
import humanPathRouter from '../src/routes/human-path';
import byokRouter from '../src/routes/v1/byok';

describe('human path and empty bind', () => {
  it('records every step with applied false', async () => {
    const app = express();
    app.use('/api/v1', humanPathRouter);
    const res = await request(app).get('/api/v1/human/path');
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(Array.isArray(res.body.steps)).toBe(true);
    expect(res.body.steps.length).toBeGreaterThan(0);
    expect(res.body.steps.every((step: { applied?: boolean }) => step.applied === false)).toBe(true);
  });

  it('empty bind is 401 and inserts nothing', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1', byokRouter);
    const before = inserts;
    const res = await request(app).post('/api/v1/human/bind').send({});
    expect(res.status).toBe(401);
    expect(inserts).toBe(before);
  });
});
