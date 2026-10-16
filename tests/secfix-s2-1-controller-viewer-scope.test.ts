/**
 * [S2-1, 2026-10-16] Controller viewers see only what they may see.
 *
 * 1. An `x-sbt-token` / `x-sbt-wallet` header is a claim (token ids and wallets are public on chain,
 *    nothing checks a signature). It granted viewer, which read the whole HITL queue, and the wallet
 *    lookup was an unescaped `.ilike`, so `%` matched any registered SBT. It now grants no role.
 * 2. An agent API key (anyone can get one from keyless /agents/register) is a viewer pinned to its
 *    own agent. It read every HITL request and every agent's tasks when the pin's name lookup came
 *    back empty. It now reads only its own agent's tasks and none of the HITL queue.
 */
jest.mock('../src/services/hitl-service', () => ({
  hitlService: {
    getPendingRequests: jest.fn(async () => [{ id: 'hitl-1' }]),
    getRequest: jest.fn(async () => ({ id: 'hitl-1' })),
  },
}));
jest.mock('../src/auth/api-keys', () => ({
  ...jest.requireActual('../src/auth/api-keys'),
  validateAgentApiKey: jest.fn(async (k: string) =>
    k === 'ts_live_agentkey' ? { agent_id: 'aaaaaaaa-1111-2222-3333-444444444444', scopes: ['read_card'] } : null,
  ),
}));

const calls: Array<[string, string, ...unknown[]]> = [];
let boundName: string | null = null;
jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const chain: any = {};
      for (const m of ['select', 'eq', 'ilike', 'gte', 'order', 'limit']) {
        chain[m] = (...args: unknown[]) => { calls.push([table, m, ...args]); return chain; };
      }
      chain.maybeSingle = () => Promise.resolve({ data: table === 'repid_agents' && boundName ? { agent_name: boundName } : null, error: null });
      chain.then = (res: any, rej: any) =>
        Promise.resolve({ data: table === 'human_sbt_registry' ? [{ token_id: 't1', wallet_address: '0xabc' }] : [{ id: 1 }], error: null }).then(res, rej);
      return chain;
    },
  },
}));

import express from 'express';
import request from 'supertest';
import controllerRouter from '../src/routes/v1/controller';
import { mintQrToken } from '../src/middleware/controller-auth';

const app = express();
app.use(express.json());
app.use('/api/v1/controller', controllerRouter);
const AGENT_KEY = 'ts_live_agentkey';
const HITL_UUID = 'cccccccc-1111-2222-3333-444444444444';

beforeEach(() => {
  calls.length = 0;
  boundName = null;
  process.env.CONTROLLER_QR_SECRET = 'test-only-controller-qr-secret';
});
afterAll(() => { delete process.env.CONTROLLER_QR_SECRET; });

describe('an SBT header grants no role', () => {
  it.each([
    ['x-sbt-token', 't1'],
    ['x-sbt-wallet', '0xabc'],
    ['x-sbt-wallet', '%'],
  ])('%s: %s → 401, and the SBT registry is never read', async (header, value) => {
    for (const path of ['/agent-grid', '/requests/pending', '/requests/history', '/activity-feed']) {
      const res = await request(app).get(`/api/v1/controller${path}`).set(header, value);
      expect(res.status).toBe(401);
    }
    expect(calls.filter(([t]) => t === 'human_sbt_registry')).toEqual([]);
  });
});

describe('an agent-key viewer reads none of the HITL queue', () => {
  it.each([null, 'my-agent'])('bound name %p: pending, history and a request by id → 403', async (name) => {
    boundName = name;
    for (const path of ['/requests/pending', '/requests/history', `/requests/${HITL_UUID}`]) {
      const res = await request(app).get(`/api/v1/controller${path}`).set('x-api-key', AGENT_KEY);
      expect(res.status).toBe(403);
    }
    expect(calls.filter(([t]) => t === 'hal_audit_chain')).toEqual([]);
  });

  it('a signed viewer token (a human the operator issued it to) still reads the queue', async () => {
    const res = await request(app).get('/api/v1/controller/requests/pending').set('x-controller-token', mintQrToken('viewer'));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([{ id: 'hitl-1' }]);
  });
});

describe("an agent-key viewer's activity feed is its own agent's tasks", () => {
  it('filters trinity_tasks by the bound agent name', async () => {
    boundName = 'my-agent';
    const res = await request(app).get('/api/v1/controller/activity-feed').set('x-api-key', AGENT_KEY);
    expect(res.status).toBe(200);
    expect(calls).toContainEqual(['trinity_tasks', 'eq', 'agent_name', 'my-agent']);
  });

  it('an unknown bound name → empty, and trinity_tasks is never read', async () => {
    const res = await request(app).get('/api/v1/controller/activity-feed').set('x-api-key', AGENT_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 0, events: [] });
    expect(calls.filter(([t]) => t === 'trinity_tasks')).toEqual([]);
  });

  it('a signed viewer token sees the whole feed (no agent filter)', async () => {
    const res = await request(app).get('/api/v1/controller/activity-feed').set('x-controller-token', mintQrToken('viewer'));
    expect(res.status).toBe(200);
    expect(calls.filter(([t, m]) => t === 'trinity_tasks' && m === 'eq')).toEqual([]);
  });
});
