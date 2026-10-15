/**
 * Write routes mounted ahead of the global authMiddleware now authenticate themselves
 * (hardening, CC1 2026-10-14; follows #1379 for /bounties).
 *
 *   POST /api/v1/hal-benchmark/run            (+ per-key rate limit: it spends model budget)
 *   POST /api/v1/marketplace/listings, PATCH /api/v1/marketplace/listings/:id, POST /api/v1/marketplace/rentals
 *   POST /api/v1/federation/heartbeat, POST /api/v1/federation/event-stream
 *   POST /api/v1/human/bind  — the staging shape only (body names a wallet). The signed bind
 *                              (no wallet in the body; trustshell's bindAgent) still falls through.
 *
 * Each: no key -> 401, unknown key -> 403, valid key -> works; an agent-bound key acts only as
 * its own agent. Routers are mounted at their real prefixes so authMiddleware sees the same
 * req.path it does in production.
 */
import express from 'express';
import request from 'supertest';

const BOUND = 'aaaaaaaa-1111-2222-3333-444444444444';
const BOUND_2 = 'cccccccc-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';

const writes: Array<{ table: string; op: string; row: unknown }> = [];
let listingOwner = BOUND;
jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const b: any = {
        select: () => b,
        eq: () => b,
        order: () => b,
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => {
          if (table === 'repid_agents') return { data: { agent_name: 'trinity-bound-agent' }, error: null };
          if (table === 'agent_listings') return { data: { id: 7, agent_id: listingOwner, status: 'paused' }, error: null };
          if (table === 'developer_nodes') return { data: { id: 3, status: 'verified', federated_optin: true }, error: null };
          return { data: null, error: null };
        },
        single: async () => ({ data: { id: 1 }, error: null }),
        insert: (row: unknown) => {
          writes.push({ table, op: 'insert', row });
          const r: any = { select: () => r, single: async () => ({ data: { id: 1 }, error: null }), then: (ok: any) => ok({ data: null, error: null }) };
          return r;
        },
        update: (row: unknown) => {
          writes.push({ table, op: 'update', row });
          return b;
        },
      };
      return b;
    },
  },
}));
jest.mock('../src/auth/api-keys', () => ({
  ...jest.requireActual('../src/auth/api-keys'),
  validateAgentApiKey: jest.fn(async (key: string) =>
    key === 'bound-key' ? { agent_id: BOUND } : key === 'bound-key-2' ? { agent_id: BOUND_2 } : null),
}));
jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn().mockResolvedValue(undefined) }));
const runTier1Benchmark = jest.fn(async () => ({ ok: true }));
jest.mock('../src/services/hal-tester', () => ({ runTier1Benchmark: () => runTier1Benchmark() }));

import halTestRouter, { BENCHMARK_RUNS_PER_HOUR } from '../src/routes/hal-test';
import marketplaceRouter from '../src/routes/v1/marketplace';
import federationRouter from '../src/routes/v1/federation';
import humanBindStagingRouter, { STAGING_BIND_LIMIT_PER_MIN } from '../src/routes/human-bind-staging';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/hal-benchmark', halTestRouter);
  a.use('/api/v1/marketplace', marketplaceRouter);
  a.use('/api/v1/federation', federationRouter);
  a.use('/api/v1', humanBindStagingRouter);
  // Stand-in for the signed bind in routes/v1/byok.ts, so a fall-through is observable.
  a.post('/api/v1/human/bind', (_req, res) => res.status(299).json({ fell_through_to_signed_bind: true }));
  return a;
}

const LISTING = { agent_id: BOUND, owner_sbt_id: 'sbt-1', listing_type: 'rent', price_usdc: 5, rep_id_at_listing: 100 };
// okKey: the key that should work. plainEnv: what a plain (non-'ops') env key gets — it may act for
// no one, so it is refused wherever a write names a party; hal-benchmark acts for no one at all.
type Route = { name: string; method: 'post' | 'patch'; path: string; body: Record<string, unknown>; ok: number; okKey: string; plainEnv: number };
const ROUTES: Route[] = [
  { name: 'POST /api/v1/hal-benchmark/run', method: 'post', path: '/api/v1/hal-benchmark/run', body: {}, ok: 200, okKey: 'bound-key-2', plainEnv: 200 },
  { name: 'POST /api/v1/marketplace/listings', method: 'post', path: '/api/v1/marketplace/listings', body: LISTING, ok: 201, okKey: 'bound-key', plainEnv: 403 },
  { name: 'PATCH /api/v1/marketplace/listings/:id', method: 'patch', path: '/api/v1/marketplace/listings/7', body: { status: 'active' }, ok: 200, okKey: 'bound-key', plainEnv: 403 },
  { name: 'POST /api/v1/marketplace/rentals', method: 'post', path: '/api/v1/marketplace/rentals', body: { listing_id: 7, renter_sbt_id: 'sbt-2' }, ok: 200, okKey: 'ops-key', plainEnv: 403 },
  { name: 'POST /api/v1/federation/heartbeat', method: 'post', path: '/api/v1/federation/heartbeat', body: { node_id: 3 }, ok: 200, okKey: 'ops-key', plainEnv: 403 },
  { name: 'POST /api/v1/federation/event-stream', method: 'post', path: '/api/v1/federation/event-stream', body: { node_id: 3, event_type: 'gradient' }, ok: 201, okKey: 'ops-key', plainEnv: 403 },
  { name: 'POST /api/v1/human/bind (staging shape)', method: 'post', path: '/api/v1/human/bind', body: { wallet: '0xabc', agent_id: BOUND }, ok: 201, okKey: 'bound-key', plainEnv: 403 },
];

beforeEach(() => {
  writes.length = 0;
  listingOwner = BOUND;
  runTier1Benchmark.mockClear();
  process.env.HUMAN_AGENT_BIND_ENABLED = 'true';
  process.env.REPID_API_KEYS = 'plain-env-key,ops-key:ops';
});
afterAll(() => {
  delete process.env.HUMAN_AGENT_BIND_ENABLED;
  delete process.env.REPID_API_KEYS;
});

const send = (a: express.Express, r: (typeof ROUTES)[number], key?: string) => {
  let q = request(a)[r.method](r.path);
  if (key) q = q.set('Authorization', `Bearer ${key}`);
  return q.send(r.body);
};

describe.each(ROUTES)('$name', (r) => {
  test('no API key → 401 with nothing written or spent; the right key → works', async () => {
    const a = app();
    const res = await send(a, r);
    expect(res.status).toBe(401);
    expect(writes).toHaveLength(0);
    expect(runTier1Benchmark).not.toHaveBeenCalled();

    const ok = await send(a, r, r.okKey);
    expect(ok.status).toBe(r.ok);
  });

  test('unknown API key → 403; nothing written, nothing spent', async () => {
    const res = await send(app(), r, 'not-a-key');
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
    expect(runTier1Benchmark).not.toHaveBeenCalled();
  });

  test('a plain env key (no agent, not an operator) is refused wherever the write names a party', async () => {
    const res = await send(app(), r, 'plain-env-key');
    expect(res.status).toBe(r.plainEnv);
    if (r.plainEnv === 403) expect(writes).toHaveLength(0);
  });
});

describe('the key names the actor', () => {
  const post = (path: string, key: string, body: Record<string, unknown>) =>
    request(app()).post(path).set('Authorization', `Bearer ${key}`).send(body);

  test('POST /listings with an agent key and no agent_id lists THAT agent', async () => {
    const { agent_id: _omit, ...rest } = LISTING;
    const res = await post('/api/v1/marketplace/listings', 'bound-key', rest);
    expect(res.status).toBe(201);
    expect(writes[0]).toMatchObject({ table: 'agent_listings', op: 'insert', row: expect.objectContaining({ agent_id: BOUND }) });
  });

  test('a non-string agent_id → 400, nothing written', async () => {
    expect((await post('/api/v1/marketplace/listings', 'bound-key', { ...LISTING, agent_id: 42 })).status).toBe(400);
    expect((await post('/api/v1/human/bind', 'bound-key', { wallet: '0xabc', agent_id: 42 })).status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  test('staging bind with an agent key and no agent_id binds THAT agent', async () => {
    const res = await post('/api/v1/human/bind', 'bound-key', { wallet: '0xabc' });
    expect(res.status).toBe(201);
    expect(writes[0]).toMatchObject({ table: 'human_agent_binds', row: { wallet: '0xabc', agent_id: BOUND } });
  });

  test('an operator key may act for a named agent', async () => {
    expect((await post('/api/v1/marketplace/listings', 'ops-key', LISTING)).status).toBe(201);
    expect((await post('/api/v1/human/bind', 'ops-key', { wallet: '0xabc', agent_id: OTHER })).status).toBe(201);
    const patch = await request(app()).patch('/api/v1/marketplace/listings/7').set('Authorization', 'Bearer ops-key').send({ status: 'paused' });
    expect(patch.status).toBe(200);
  });

  test('rentals and node reports refuse an agent key: no credential here proves a renter SBT or a node', async () => {
    expect((await post('/api/v1/marketplace/rentals', 'bound-key', { listing_id: 7, renter_sbt_id: 'sbt-2' })).status).toBe(403);
    expect((await post('/api/v1/federation/heartbeat', 'bound-key', { node_id: 3 })).status).toBe(403);
    expect((await post('/api/v1/federation/event-stream', 'bound-key', { node_id: 3, event_type: 'gradient' })).status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});

describe('an agent key acts only as its own agent', () => {
  test('POST /listings naming another agent → 403', async () => {
    const res = await request(app()).post('/api/v1/marketplace/listings').set('Authorization', 'Bearer bound-key').send({ ...LISTING, agent_id: OTHER });
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  test("PATCH another agent's listing → 403, no update", async () => {
    listingOwner = OTHER;
    const res = await request(app()).patch('/api/v1/marketplace/listings/7').set('Authorization', 'Bearer bound-key').send({ status: 'sold' });
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  test('staging bind naming another agent → 403, nothing inserted', async () => {
    const res = await request(app()).post('/api/v1/human/bind').set('Authorization', 'Bearer bound-key').send({ wallet: '0xabc', agent_id: OTHER });
    expect(res.status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});

test('only the staging shape is gated: it needs a key (401) while the signed bind still falls through without one', async () => {
  const a = app();
  const staging = await request(a).post('/api/v1/human/bind').send({ wallet: '0xabc', agent_id: BOUND });
  expect(staging.status).toBe(401);

  // trustshell's bindAgent sends { agent_id, signature, scope } with wallet-signature headers and no API key.
  const signed = await request(a).post('/api/v1/human/bind').send({ agent_id: BOUND, signature: '0xsig', scope: 'ownership' });
  expect(signed.status).toBe(299);
  expect(writes).toHaveLength(0);
});

test(`hal-benchmark/run: run ${BENCHMARK_RUNS_PER_HOUR + 1} in an hour from one key → 429; another key is unaffected`, async () => {
  const a = app();
  for (let i = 0; i < BENCHMARK_RUNS_PER_HOUR; i++) {
    const ok = await request(a).post('/api/v1/hal-benchmark/run').set('Authorization', 'Bearer bound-key').send({});
    expect(ok.status).toBe(200);
  }
  const limited = await request(a).post('/api/v1/hal-benchmark/run').set('Authorization', 'Bearer bound-key').send({});
  expect(limited.status).toBe(429);
  expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  expect(runTier1Benchmark).toHaveBeenCalledTimes(BENCHMARK_RUNS_PER_HOUR);

  const other = await request(a).post('/api/v1/hal-benchmark/run').set('Authorization', 'Bearer bound-key-2').send({});
  expect(other.status).toBe(200);
});

// LAST in the file on purpose: the limiter is module-level, so this exhausts the bucket for this IP.
test(`staging bind: ${STAGING_BIND_LIMIT_PER_MIN + 1} staging requests from one IP in a minute → 429; the signed bind is never counted`, async () => {
  const a = app();
  for (let i = 0; i < STAGING_BIND_LIMIT_PER_MIN; i++) {
    await request(a).post('/api/v1/human/bind').send({ wallet: '0xabc', agent_id: BOUND });
  }
  const limited = await request(a).post('/api/v1/human/bind').send({ wallet: '0xabc', agent_id: BOUND });
  expect(limited.status).toBe(429);
  const signed = await request(a).post('/api/v1/human/bind').send({ agent_id: BOUND, signature: '0xsig', scope: 'ownership' });
  expect(signed.status).toBe(299);
});
