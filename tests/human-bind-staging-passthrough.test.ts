/**
 * POST /api/v1/human/bind is served by two routers, mounted in this order (src/index.ts):
 * human-bind-staging, then the signed bind in routes/v1/byok.ts, whose body is
 * { agent_id, signature, scope } with the wallet taken from the authenticated principal.
 *
 * Measured 2026-10-06 from the code: the staging handler answered every such body with
 * 400 { error: 'rejected' } (agent_id present, no wallet), so the signed bind never ran.
 * HUMAN_AGENT_BIND_ENABLED reads ON in production, and the staging table it inserts into
 * (human_agent_binds) does not exist there. Only a body that names a wallet is the staging
 * route's; anything else must reach the signed route.
 */
import express from 'express';
import request from 'supertest';

const insert = jest.fn(async () => ({ error: null }));
jest.mock('../src/db', () => ({ db: { from: () => ({ insert }) } }));

import humanBindStagingRouter from '../src/routes/human-bind-staging';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1', humanBindStagingRouter);
  // Stand-in for the signed bind route mounted next (routes/v1/byok.ts).
  a.post('/api/v1/human/bind', (_req, res) => res.status(299).json({ reached: 'signed-bind' }));
  return a;
}

const AGENT = 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271';
const realEnv = process.env.HUMAN_AGENT_BIND_ENABLED;
beforeEach(() => {
  insert.mockClear();
  process.env.HUMAN_AGENT_BIND_ENABLED = 'true';
});
afterAll(() => {
  if (realEnv === undefined) delete process.env.HUMAN_AGENT_BIND_ENABLED;
  else process.env.HUMAN_AGENT_BIND_ENABLED = realEnv;
});

describe('the staging bind never swallows the signed bind', () => {
  it('a signed-bind body (agent_id + signature, no wallet) reaches the signed route', async () => {
    const res = await request(app()).post('/api/v1/human/bind').send({ agent_id: AGENT, signature: '0xabc', scope: 'ownership' });
    expect(res.status).toBe(299);
    expect(res.body).toEqual({ reached: 'signed-bind' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('`agent` alone (no wallet) also passes through', async () => {
    const res = await request(app()).post('/api/v1/human/bind').send({ agent: AGENT });
    expect(res.status).toBe(299);
  });

  it('a body naming a wallet is still the staging route\'s (unchanged)', async () => {
    const res = await request(app()).post('/api/v1/human/bind').send({ wallet: '0x1111111111111111111111111111111111111111', agent_id: AGENT });
    expect(res.status).toBe(201);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('flag off: a wallet body is 410 and inserts nothing (unchanged)', async () => {
    process.env.HUMAN_AGENT_BIND_ENABLED = 'false';
    const res = await request(app()).post('/api/v1/human/bind').send({ wallet: '0x1111111111111111111111111111111111111111', agent_id: AGENT });
    expect(res.status).toBe(410);
    expect(insert).not.toHaveBeenCalled();
  });
});
