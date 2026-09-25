/**
 * Help B writes stay closed. The database is a double. No production call.
 */

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';
delete process.env.HELP_B_WRITES_ENABLED;

jest.mock('../src/db', () => {
  const chain: any = {
    insert: (row: { n?: number; value?: number }) => {
      (globalThis as { __helpBInserts?: unknown[] }).__helpBInserts =
        ((globalThis as { __helpBInserts?: unknown[] }).__helpBInserts ?? []).concat(row);
      return Promise.resolve({ error: null });
    },
  };
  return { db: { from: () => chain, rpc: async () => ({ data: null, error: null }) } };
});

import express from 'express';
import request from 'supertest';
import helpBRouter from '../src/routes/help-b';

function inserted(): Array<{ n?: number; value?: number }> {
  return (globalThis as { __helpBInserts?: Array<{ n?: number; value?: number }> }).__helpBInserts ?? [];
}

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/v1', helpBRouter);
  return server;
}

describe('POST /api/v1/help-b/rate', () => {
  const saved = process.env.HELP_B_WRITES_ENABLED;

  beforeEach(() => {
    (globalThis as { __helpBInserts?: unknown[] }).__helpBInserts = [];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.HELP_B_WRITES_ENABLED;
    else process.env.HELP_B_WRITES_ENABLED = saved;
  });

  it('flag off is 410 and inserts nothing', async () => {
    delete process.env.HELP_B_WRITES_ENABLED;
    const res = await request(app()).post('/api/v1/help-b/rate').send({
      rater_type: 'human',
      subject: 'family',
      dim: 'helpful',
      value: 0,
      n: 3,
    });
    expect(res.status).toBe(410);
    expect(res.body.stored).toBe(false);
    expect(inserted()).toEqual([]);
  });

  it('missing n is not stored as 0', async () => {
    process.env.HELP_B_WRITES_ENABLED = 'true';
    const res = await request(app()).post('/api/v1/help-b/rate').send({
      rater_type: 'human',
      subject: 'agent',
      dim: 'accurate',
      value: 0,
    });
    expect(res.status).toBe(422);
    expect(res.body.status).toBe('NOT_CHECKED');
    expect(res.body.value).toBeNull();
    expect(res.body.stored).toBe(false);
    expect(inserted()).toEqual([]);
    expect(JSON.stringify(inserted())).not.toContain('"n":0');
  });

  it('TRUE is not the exact string, so it stays closed', async () => {
    process.env.HELP_B_WRITES_ENABLED = 'TRUE';
    const res = await request(app()).post('/api/v1/help-b/rate').send({ n: 1, value: 1, rater_type: 'agent', subject: 'family', dim: 'deep' });
    expect(res.status).toBe(410);
    expect(inserted()).toEqual([]);
  });
});
