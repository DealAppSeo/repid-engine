process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

let inserts = 0;

jest.mock('../src/db', () => {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.insert = (row: unknown) => {
    inserts += 1;
    (globalThis as { __helpBRow?: unknown }).__helpBRow = row;
    return Promise.resolve({ error: null });
  };
  for (const name of ['select', 'eq', 'limit']) chain[name] = self;
  return { db: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});

import express from 'express';
import request from 'supertest';
import helpBRouter from '../src/routes/help-b';

describe('POST /api/v1/help-b/rate', () => {
  const saved = process.env.HELP_B_WRITES_ENABLED;

  beforeEach(() => {
    inserts = 0;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.HELP_B_WRITES_ENABLED;
    else process.env.HELP_B_WRITES_ENABLED = saved;
  });

  function app() {
    const server = express();
    server.use(express.json());
    server.use('/api/v1', helpBRouter);
    return server;
  }

  it('is 410 unless the flag is the exact string true', async () => {
    delete process.env.HELP_B_WRITES_ENABLED;
    const closed = await request(app()).post('/api/v1/help-b/rate').send({ n: 1, value: 1 });
    expect(closed.status).toBe(410);
    expect(inserts).toBe(0);

    process.env.HELP_B_WRITES_ENABLED = 'TRUE';
    const folded = await request(app()).post('/api/v1/help-b/rate').send({ n: 1, value: 1 });
    expect(folded.status).toBe(410);
    expect(inserts).toBe(0);
  });

  it('missing n is NOT_CHECKED and is not stored as 0', async () => {
    process.env.HELP_B_WRITES_ENABLED = 'true';
    const res = await request(app()).post('/api/v1/help-b/rate').send({
      rater_type: 'human',
      subject: 'family',
      dim: 'helpful',
      value: 1,
    });
    expect(res.status).toBe(422);
    expect(res.body.status).toBe('NOT_CHECKED');
    expect(res.body.n).toBeNull();
    expect(res.body.n).not.toBe(0);
    expect(res.body.value).toBeNull();
    expect(res.body.stored).toBe(false);
    expect(inserts).toBe(0);
  });
});
