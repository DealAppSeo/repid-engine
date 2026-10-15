/**
 * [S1 2026-10-14] A self-registered agent key is not a controller admin.
 *
 * POST /api/v1/agents/register is keyless and used to issue every new agent a key scoped
 * ['score_event','llm_complete','read_card','admin']. The Controller API is mounted before
 * authMiddleware, and resolveControllerRole mapped an 'admin' scope to the admin role. So one
 * unauthenticated POST was enough to sleep/wake any agent, dispatch sprints and directives, mint
 * controller tokens, and approve or deny HITL requests.
 *
 * Every refusal below was a 200 on main before this fix.
 */
jest.mock('../src/services/agent-controls', () => ({
  setAgentEnabled: jest.fn().mockResolvedValue({ agent_name: 'trinity-mel', enabled: false }),
}));
jest.mock('../src/services/hitl-service', () => ({
  hitlService: { resolveRequest: jest.fn().mockResolvedValue({ id: 'r1', status: 'resolved' }) },
}));
jest.mock('../src/auth/api-keys', () => ({
  ...jest.requireActual('../src/auth/api-keys'),
  validateAgentApiKey: jest.fn(async (k: string) =>
    k === 'ts_live_selfregistered'
      ? { agent_id: 'aaaaaaaa-1111-2222-3333-444444444444', scopes: ['score_event', 'llm_complete', 'read_card', 'admin'] }
      : null,
  ),
}));
jest.mock('../src/db', () => {
  const chain: any = {
    select: () => chain, insert: () => chain, eq: () => chain, ilike: () => chain, gte: () => chain,
    order: () => chain, limit: () => chain,
    single: () => Promise.resolve({ data: { id: 42 }, error: null }),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    then: (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej),
  };
  return { db: { from: () => chain } };
});

import express from 'express';
import request from 'supertest';
import controllerRouter from '../src/routes/v1/controller';
import { mintQrToken, requireRole } from '../src/middleware/controller-auth';
import { issueAgentApiKey } from '../src/auth/api-keys';
import { setAgentEnabled } from '../src/services/agent-controls';

const SELF_KEY = 'ts_live_selfregistered';
const AGENT_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const AGENT_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const MASTER = 'test-only-controller-master-key';
const QR_SECRET = 'test-only-controller-qr-secret';

const app = express();
app.use(express.json());
app.use('/api/v1/controller', controllerRouter);

const DIRECTIVE = {
  agent_name: 'trinity-mel', title: 't', description: 'd',
  success_criteria: 'The report lists every failing check by name.', expected_output: 'a report',
};
const SPRINT = { title: 't', description: 'd' };
const HITL_ID = 'cccccccc-1111-2222-3333-444444444444';

const writes: Array<[string, string, object]> = [
  ['sleep', '/sleep/trinity-mel', {}],
  ['wake', '/wake/trinity-mel', {}],
  ['sprint', '/sprint/trinity-mel', SPRINT],
  ['decide', `/requests/${HITL_ID}/decide`, { decision: 'approved' }],
  ['token', '/token', { role: 'admin' }],
  ['directives', '/directives', DIRECTIVE],
  ['leads', '/leads', { email: 'x@example.com' }],
];

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CONTROLLER_MASTER_KEY;
  delete process.env.CONTROLLER_QR_SECRET;
});

describe('a self-registered agent key (scopes include the legacy "admin") cannot drive the controller', () => {
  it.each(writes)('%s → 403', async (_n, path, body) => {
    process.env.CONTROLLER_QR_SECRET = QR_SECRET; // configured, as in prod; the key still is not a token
    for (const set of [
      (r: request.Test) => r.set('authorization', `Bearer ${SELF_KEY}`),
      (r: request.Test) => r.set('x-api-key', SELF_KEY),
    ]) {
      const res = await set(request(app).post(`/api/v1/controller${path}`)).send(body);
      expect(res.status).toBe(403);
    }
    expect(setAgentEnabled).not.toHaveBeenCalled();
  });

  it('is still a viewer: the read-only grid answers', async () => {
    const res = await request(app).get('/api/v1/controller/agent-grid').set('x-api-key', SELF_KEY);
    expect(res.status).toBe(200);
  });

  it('a master key that is set does not make an agent key admin', async () => {
    process.env.CONTROLLER_MASTER_KEY = MASTER;
    const res = await request(app).post('/api/v1/controller/sleep/trinity-mel').set('x-api-key', SELF_KEY).send({});
    expect(res.status).toBe(403);
  });
});

describe('operator credentials still work', () => {
  it('CONTROLLER_MASTER_KEY is admin on its own (it need not also be a DB key)', async () => {
    process.env.CONTROLLER_MASTER_KEY = MASTER;
    const res = await request(app).post('/api/v1/controller/sleep/trinity-mel').set('x-api-key', MASTER).send({});
    expect(res.status).toBe(200);
    expect(setAgentEnabled).toHaveBeenCalledWith('trinity-mel', false, 'controller', 'controller /sleep');
  });

  it('an unset master key matches nothing, including an empty header (fail closed)', async () => {
    const res = await request(app).post('/api/v1/controller/sleep/trinity-mel').set('x-api-key', '').send({});
    expect(res.status).toBe(401);
  });

  it('a signed admin controller token is admin', async () => {
    process.env.CONTROLLER_QR_SECRET = QR_SECRET;
    const res = await request(app).post('/api/v1/controller/wake/trinity-mel').set('x-controller-token', mintQrToken('admin')).send({});
    expect(res.status).toBe(200);
  });

  it('a signed operator controller token decides HITL requests', async () => {
    process.env.CONTROLLER_QR_SECRET = QR_SECRET;
    const res = await request(app).post(`/api/v1/controller/requests/${HITL_ID}/decide`)
      .set('x-controller-token', mintQrToken('operator')).send({ decision: 'denied' });
    expect(res.status).toBe(200);
  });
});

describe('an agent-key caller is pinned to its own agent, including :agent_id in the path', () => {
  const pinned = express();
  pinned.use(express.json());
  pinned.post('/x/:agent_id', requireRole('viewer'), (_req, res) => { res.json({ ok: true }); });

  it("another agent's id in the path → 403", async () => {
    const res = await request(pinned).post(`/x/${AGENT_B}`).set('x-api-key', SELF_KEY).send({});
    expect(res.status).toBe(403);
  });

  it('its own id in the path → allowed', async () => {
    const res = await request(pinned).post(`/x/${AGENT_A}`).set('x-api-key', SELF_KEY).send({});
    expect(res.status).toBe(200);
  });
});

describe('issueAgentApiKey refuses reserved scopes', () => {
  it.each(['admin', 'operator'])('%s is never written', async (scope) => {
    await expect(issueAgentApiKey(AGENT_A, 'k', ['read_card', scope])).rejects.toThrow(/reserved scope/);
  });
});

describe('[S1 follow-up] a signed token is only as good as its role allowlist and expiry', () => {
  // Signed with the real secret, so these isolate the payload checks. `roleHierarchy[unknown] < n`
  // is `undefined < n` (false), so an unknown role was admitted at every level; and
  // `Date.now() > undefined` is false, so a token with no expiry never expired.
  const forge = (payload: object): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const crypto = require('crypto');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', QR_SECRET).update(body).digest('hex')}`;
  };
  const future = () => Date.now() + 60_000;

  it.each(['superadmin', 'constructor', 'toString', '', 3])('role %p is no role → 401', async (role) => {
    process.env.CONTROLLER_QR_SECRET = QR_SECRET;
    const token = forge({ role, expiresAt: future() });
    const write = await request(app).post('/api/v1/controller/wake/trinity-mel').set('x-controller-token', token).send({});
    expect(write.status).toBe(401);
    const read = await request(app).get('/api/v1/controller/agent-grid').set('x-controller-token', token);
    expect(read.status).toBe(401);
    expect(setAgentEnabled).not.toHaveBeenCalled();
  });

  it.each([undefined, '9999999999999', null])('an admin token whose expiresAt is %p → 401', async (expiresAt) => {
    process.env.CONTROLLER_QR_SECRET = QR_SECRET;
    const res = await request(app).post('/api/v1/controller/wake/trinity-mel')
      .set('x-controller-token', forge({ role: 'admin', expiresAt })).send({});
    expect(res.status).toBe(401);
  });

  it('the master key matches exactly: a prefix or an extension of it is not master', async () => {
    process.env.CONTROLLER_MASTER_KEY = MASTER;
    for (const k of [MASTER.slice(0, -1), `${MASTER}x`, MASTER.toUpperCase()]) {
      const res = await request(app).post('/api/v1/controller/sleep/trinity-mel').set('x-api-key', k).send({});
      expect(res.status).toBe(401);
    }
    expect((await request(app).post('/api/v1/controller/sleep/trinity-mel').set('x-api-key', MASTER).send({})).status).toBe(200);
  });
});
