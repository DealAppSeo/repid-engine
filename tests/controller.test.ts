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
        // Added for L2 breaker 2.2: /sprint reads the declared parent row with
        // .maybeSingle(). Distinct handle so a test can make the parent lookup
        // and the insert return different rows; falls back to `single` so every
        // pre-existing mock keeps behaving exactly as before.
        maybeSingle: () => Promise.resolve(h.maybeSingle ?? h.single ?? { data: null }),
        then: (res: any, rej: any) => Promise.resolve(h.await ?? { data: [] }).then(res, rej),
      };
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

const SBT_ROW = { token_id: 't1', wallet_address: '0xabc', qualification_tier: 'retail' };

function setMock(tables: any) { (global as any).__ctrlMock = tables; }
afterEach(() => {
  delete (global as any).__ctrlMock;
  delete process.env.CONTROLLER_MASTER_SBT;
  delete process.env.CONTROLLER_QR_SECRET;
});

// [F-15] Admin comes from an API key with that scope or a QR token signed with CONTROLLER_QR_SECRET,
// never from an SBT named in a header. The sprint and wake tests below use a token minted with a
// test-only secret, so they keep testing what is behind the gate.
const TEST_QR_SECRET = 'test-only-controller-qr-secret';
function adminToken(): string {
  process.env.CONTROLLER_QR_SECRET = TEST_QR_SECRET;
  return mintQrToken('admin');
}

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

test('wake: admin token → 200 + wake_task_id', async () => {
  const inserts: any[] = [];
  setMock({
    human_sbt_registry: { await: { data: [SBT_ROW] } },
    trinity_tasks: { single: { data: { id: 4242 } }, _insert: (v: any) => inserts.push(v) },
  });
  const r = await request(app).post('/api/v1/controller/wake/trinity-mel').set('x-controller-token', adminToken()).send({});
  expect(r.status).toBe(200);
  expect(r.body.wake_task_id).toBe(4242);
  expect(inserts[0].title).toBe('CONTROLLER_WAKE');
  expect(inserts[0].assigned_to).toBe('trinity-mel');
  expect(inserts[0].insert_source).toBe('controller');
});

test('sprint: admin, missing title → 400', async () => {
  setMock({ human_sbt_registry: { await: { data: [SBT_ROW] } } });
  const r = await request(app).post('/api/v1/controller/sprint/trinity-mel').set('x-controller-token', adminToken()).send({ description: 'x' });
  expect(r.status).toBe(400);
});

// ─────────────────────────────────────────────────────────────────────────────
// L2 breaker 2.2 — lineage + depth budget, at the HTTP surface.
// The unit suite (tests/task-lineage.test.ts) pins the library. These pin the
// WIRING: that /sprint actually reads the parent from the DB, actually writes
// the lineage columns, and actually returns 400 at the budget — the backlog's
// stated acceptance criterion ("5-deep succeeds; depth 6 → 400").
// ─────────────────────────────────────────────────────────────────────────────

function sprintMock(parentRow: any, inserts: any[]) {
  setMock({
    human_sbt_registry: { await: { data: [SBT_ROW] } },
    trinity_tasks: {
      maybeSingle: { data: parentRow },
      single: { data: { id: 9001 } },
      _insert: (v: any) => inserts.push(v),
    },
  });
}

const SPRINT_BODY = { title: 'child sprint', description: 'do the thing' };

test('sprint: no parent declared → ROOT lineage written (parent null, generation 0)', async () => {
  const inserts: any[] = [];
  sprintMock(null, inserts);
  const r = await request(app).post('/api/v1/controller/sprint/trinity-mel')
    .set('x-controller-token', adminToken()).send(SPRINT_BODY);
  expect(r.status).toBe(200);
  expect(inserts[0].parent_task_id).toBeNull();
  expect(inserts[0].generation).toBe(0);
});

test('sprint: parent at generation 0 → child written at generation 1', async () => {
  const inserts: any[] = [];
  sprintMock({ id: 77, generation: 0 }, inserts);
  const r = await request(app).post('/api/v1/controller/sprint/trinity-mel')
    .set('x-controller-token', adminToken()).send({ ...SPRINT_BODY, parent_task_id: 77 });
  expect(r.status).toBe(200);
  expect(inserts[0].parent_task_id).toBe(77);
  expect(inserts[0].generation).toBe(1);
});

test('sprint: parent at the budget edge (gen 4) still succeeds → child gen 5', async () => {
  const inserts: any[] = [];
  sprintMock({ id: 77, generation: 4 }, inserts);
  const r = await request(app).post('/api/v1/controller/sprint/trinity-mel')
    .set('x-controller-token', adminToken()).send({ ...SPRINT_BODY, parent_task_id: 77 });
  expect(r.status).toBe(200);
  expect(inserts[0].generation).toBe(5);
});

test('sprint: ACCEPTANCE — a child that would be generation 6 → 400 lineage_depth_exceeded, nothing inserted', async () => {
  const inserts: any[] = [];
  sprintMock({ id: 77, generation: 5 }, inserts);
  const r = await request(app).post('/api/v1/controller/sprint/trinity-mel')
    .set('x-controller-token', adminToken()).send({ ...SPRINT_BODY, parent_task_id: 77 });
  expect(r.status).toBe(400);
  expect(r.body.error).toBe('lineage_depth_exceeded');
  expect(r.body.depth).toBe(6);
  expect(r.body.max_depth).toBe(5);
  // the refusal must be a REFUSAL, not a 400 after the row already landed
  expect(inserts).toHaveLength(0);
});

test('sprint: a caller-supplied generation is IGNORED — depth comes from the DB row only', async () => {
  // The laundering bypass: if the body could set its own depth, any client
  // could reset to 0 and walk through the breaker forever.
  const inserts: any[] = [];
  sprintMock({ id: 77, generation: 5 }, inserts);
  const r = await request(app).post('/api/v1/controller/sprint/trinity-mel')
    .set('x-controller-token', adminToken())
    .send({ ...SPRINT_BODY, parent_task_id: 77, generation: 0 });
  expect(r.status).toBe(400);
  expect(inserts).toHaveLength(0);
});

test('sprint: a non-existent parent → 400, and no task is created', async () => {
  const inserts: any[] = [];
  sprintMock(null, inserts);
  const r = await request(app).post('/api/v1/controller/sprint/trinity-mel')
    .set('x-controller-token', adminToken()).send({ ...SPRINT_BODY, parent_task_id: 12345 });
  expect(r.status).toBe(400);
  expect(r.body.error).toBe('parent_task_id does not exist');
  expect(inserts).toHaveLength(0);
});

test('sprint: a malformed parent_task_id is rejected before any DB read', async () => {
  const inserts: any[] = [];
  sprintMock({ id: 77, generation: 0 }, inserts);
  for (const bad of ['77', -1, 0, 1.5, {}, []]) {
    const r = await request(app).post('/api/v1/controller/sprint/trinity-mel')
      .set('x-controller-token', adminToken()).send({ ...SPRINT_BODY, parent_task_id: bad });
    expect(r.status).toBe(400);
  }
  expect(inserts).toHaveLength(0);
});

test('sprint: a parent row with a corrupt generation is REFUSED (fail-closed at the HTTP edge)', async () => {
  const inserts: any[] = [];
  sprintMock({ id: 77, generation: -4 }, inserts);
  const r = await request(app).post('/api/v1/controller/sprint/trinity-mel')
    .set('x-controller-token', adminToken()).send({ ...SPRINT_BODY, parent_task_id: 77 });
  expect(r.status).toBe(400);
  expect(r.body.error).toBe('lineage_depth_exceeded');
  // depth is nulled rather than leaking the sentinel integer to a client
  expect(r.body.depth).toBeNull();
  expect(inserts).toHaveLength(0);
});

test('wake: writes explicit ROOT lineage', async () => {
  const inserts: any[] = [];
  setMock({
    human_sbt_registry: { await: { data: [SBT_ROW] } },
    trinity_tasks: { single: { data: { id: 4243 } }, _insert: (v: any) => inserts.push(v) },
  });
  const r = await request(app).post('/api/v1/controller/wake/trinity-mel')
    .set('x-controller-token', adminToken()).send({});
  expect(r.status).toBe(200);
  expect(inserts[0].parent_task_id).toBeNull();
  expect(inserts[0].generation).toBe(0);
});

describe('[F-15] the controller accepts no credential anyone can construct', () => {
  const OLD_PUBLIC_DEFAULT = 'controller-secret-key-1337-abc';
  const forge = (secret: string, role: string) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('crypto');
    const body = Buffer.from(JSON.stringify({ role, expiresAt: Date.now() + 3600_000 })).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  };

  test('no CONTROLLER_QR_SECRET: a token signed with the old public default is refused', async () => {
    setMock({ human_sbt_registry: { await: { data: [] } } });
    const r = await request(app).post('/api/v1/controller/wake/trinity-mel')
      .set('x-controller-token', forge(OLD_PUBLIC_DEFAULT, 'admin')).send({});
    expect(r.status).toBe(401);
  });

  test('secret set: a token signed with any other secret is refused', async () => {
    process.env.CONTROLLER_QR_SECRET = TEST_QR_SECRET;
    setMock({ human_sbt_registry: { await: { data: [] } } });
    const r = await request(app).post('/api/v1/controller/wake/trinity-mel')
      .set('x-controller-token', forge(OLD_PUBLIC_DEFAULT, 'admin')).send({});
    expect(r.status).toBe(401);
  });

  test('no CONTROLLER_QR_SECRET: nothing is minted', () => {
    expect(() => mintQrToken('viewer')).toThrow(/CONTROLLER_QR_SECRET is not set/);
  });

  test('POST /token without the secret answers 503 instead of a token signed with a public string', async () => {
    process.env.CONTROLLER_QR_SECRET = TEST_QR_SECRET;
    const operator = mintQrToken('operator');
    delete process.env.CONTROLLER_QR_SECRET;
    setMock({ human_sbt_registry: { await: { data: [] } } });
    // The operator token no longer verifies either, so the route refuses at the gate.
    const r = await request(app).post('/api/v1/controller/token').set('x-controller-token', operator).send({});
    expect([401, 503]).toContain(r.status);
    expect(r.body.token).toBeUndefined();
  });

  test('an SBT named in a header reads but never writes, even the master or an institutional tier', async () => {
    process.env.CONTROLLER_MASTER_SBT = 't1';
    setMock({ human_sbt_registry: { await: { data: [{ ...SBT_ROW, qualification_tier: 'institutional' }] } } });
    const wake = await request(app).post('/api/v1/controller/wake/trinity-mel').set('x-sbt-token', 't1').send({});
    expect(wake.status).toBe(403);
    const decide = await request(app).post('/api/v1/controller/requests/r1/decide')
      .set('x-sbt-wallet', '0xabc').send({ decision: 'approved' });
    expect(decide.status).toBe(403);
  });
});
