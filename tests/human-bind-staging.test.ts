import express from 'express';
import request from 'supertest';

type Row = { wallet: string; agent_id: string };

const state: { rows: Row[]; failCode: string | null } = { rows: [], failCode: null };

jest.mock('../src/db', () => ({
  db: {
    from(table: string) {
      if (table !== 'human_agent_binds') throw new Error(`unexpected table ${table}`);
      return {
        insert(row: Row) {
          if (state.failCode) {
            const code = state.failCode;
            state.failCode = null;
            return Promise.resolve({ error: { code } });
          }
          const dup = state.rows.some((item) => item.wallet === row.wallet && item.agent_id === row.agent_id);
          if (dup) return Promise.resolve({ error: { code: '23505' } });
          state.rows.push({ wallet: row.wallet, agent_id: row.agent_id });
          return Promise.resolve({ error: null });
        },
      };
    },
  },
}));

import humanBindStagingRouter from '../src/routes/human-bind-staging';

const AGENT = '11111111-1111-4111-8111-111111111111';
const PAIR = { wallet: '0xabc', agent_id: AGENT };

function app() {
  const server = express();
  server.use(express.json());
  server.use('/api/v1', humanBindStagingRouter);
  server.use('/api/v1', (_req, res) => {
    res.status(401).json({ error: 'unauthorized' });
  });
  return server;
}

describe('POST /api/v1/human/bind staging row', () => {
  beforeEach(() => {
    state.rows = [];
    state.failCode = null;
  });

  it('requires wallet and agent and inserts nothing when one is missing', async () => {
    const walletOnly = await request(app()).post('/api/v1/human/bind').send({ wallet: '0xabc' });
    const agentOnly = await request(app()).post('/api/v1/human/bind').send({ agent_id: AGENT });
    expect(walletOnly.status).toBe(400);
    expect(agentOnly.status).toBe(400);
    expect(walletOnly.body).toEqual({ error: 'rejected' });
    expect(state.rows).toHaveLength(0);
  });

  it('inserts one row and returns 409 for the same pair', async () => {
    const first = await request(app()).post('/api/v1/human/bind').send(PAIR);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ ok: true });
    expect(state.rows).toEqual([PAIR]);

    const second = await request(app()).post('/api/v1/human/bind').send({ ...PAIR, agent: AGENT });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: 'conflict' });
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).not.toHaveProperty('claim');
  });

  it('leaves an empty body to the existing bind route', async () => {
    const res = await request(app()).post('/api/v1/human/bind').send({});
    expect(res.status).toBe(401);
    expect(state.rows).toHaveLength(0);
  });
});
