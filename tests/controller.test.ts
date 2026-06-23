/**
 * Controller API — endpoint + auth tests (CC2 2026-05-26).
 * SBT gate (401/403/pass + master), agent-grid shaping, squads, wake (master-gated insert).
 * db mocked via a call-time global holder; routes exercised through supertest.
 */
jest.mock('../src/services/agent-controls', () => ({
  setAgentEnabled: jest.fn().mockResolvedValue({
    agent_name: 'mel',
    enabled: true,
    updated_by: 'controller',
    reason: 'controller /wake',
    updated_at: '2026-06-20T00:00:00.000Z',
  }),
}));

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const st = (global as any).__ctrlMock || {};
      const h = st[table] || {};
      const chain: any = {
        select: () => chain,
        insert: (v: any) => { if (h._insert) h._insert(v); return chain; },
        eq: () => chain,
        ilike: () => chain,
        gte: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve(h.single ?? { data: null }),
        then: (res: any, rej: any) => Promise.resolve(h.await ?? { data: [] }).then(res, rej),
      };
      return chain;
    },
  },
}));

import express from 'express';
import request from 'supertest';
import controllerRouter from '../src/routes/v1/controller';

const app = express();
app.use(express.json());
app.use('/api/v1/controller', controllerRouter);

const SBT_ROW = { token_id: 't1', wallet_address: '0xabc', qualification_tier: 'retail' };

function setMock(tables: any) { (global as any).__ctrlMock = tables; }
afterEach(() => { delete (global as any).__ctrlMock; delete process.env.CONTROLLER_MASTER_SBT; });

test('agent-grid: no SBT header → 401', async () => {
  setMock({ human_sbt_registry: { await: { data: [] } } });
  const r = await request(app).get('/api/v1/controller/agent-grid');
  expect(r.status).toBe(401);
});

test('agent-grid: valid SBT → 200 with live/uptime computed', async () => {
  const now = new Date().toISOString();
  setMock({
    human_sbt_registry: { await: { data: [SBT_ROW] } },
    agent_heartbeat: { await: { data: [
      { agent_name: 'trinity-mel', status: 'online', last_ping: now, loop_count: 5, code_version: 'v8', current_task_id: null },
      { agent_name: 'trinity-old', status: 'idle', last_ping: '2020-01-01T00:00:00Z', loop_count: 1, code_version: 'v1', current_task_id: null },
    ] } },
    repid_agents: { await: { data: [{ agent_name: 'trinity-mel', current_repid: 10, tier: 'PROBATIONARY' }] } },
  });
  const r = await request(app).get('/api/v1/controller/agent-grid').set('x-sbt-token', 't1');
  expect(r.status).toBe(200);
  expect(r.body.count).toBe(2);
  expect(r.body.live).toBe(1); // only the fresh ping counts
  expect(r.body.uptime_pct).toBe(50);
  expect(r.body.agents[0].repid).toBe(10);
});

test('squads: reads agent_squad_map → grouped', async () => {
  setMock({
    human_sbt_registry: { await: { data: [SBT_ROW] } },
    agent_squad_map: { await: { data: [
      { agent_name: 'a', squad: 'alpha', role: 'judge', is_active: true },
      { agent_name: 'b', squad: 'alpha', role: 'trader', is_active: true },
      { agent_name: 'c', squad: 'beta', role: 'researcher', is_active: true },
    ] } },
  });
  const r = await request(app).get('/api/v1/controller/squads').set('x-sbt-token', 't1');
  expect(r.status).toBe(200);
  expect(r.body.squad_count).toBe(2);
});

test('wake: valid SBT but NOT master → 403', async () => {
  setMock({ human_sbt_registry: { await: { data: [SBT_ROW] } } });
  // CONTROLLER_MASTER_SBT unset → nobody is master
  const r = await request(app).post('/api/v1/controller/wake/trinity-mel').set('x-sbt-token', 't1').send({});
  expect(r.status).toBe(403);
});

test('wake: master SBT → 200 + wake_task_id', async () => {
  process.env.CONTROLLER_MASTER_SBT = 't1';
  const inserts: any[] = [];
  setMock({
    human_sbt_registry: { await: { data: [SBT_ROW] } },
    trinity_tasks: { single: { data: { id: 4242 } }, _insert: (v: any) => inserts.push(v) },
  });
  const r = await request(app).post('/api/v1/controller/wake/trinity-mel').set('x-sbt-token', 't1').send({});
  expect(r.status).toBe(200);
  expect(r.body.wake_task_id).toBe(4242);
  expect(inserts[0].title).toBe('CONTROLLER_WAKE');
  expect(inserts[0].assigned_to).toBe('trinity-mel');
  expect(inserts[0].insert_source).toBe('controller');
});

test('sprint: master, missing title → 400', async () => {
  process.env.CONTROLLER_MASTER_SBT = 't1';
  setMock({ human_sbt_registry: { await: { data: [SBT_ROW] } } });
  const r = await request(app).post('/api/v1/controller/sprint/trinity-mel').set('x-sbt-token', 't1').send({ description: 'x' });
  expect(r.status).toBe(400);
});
