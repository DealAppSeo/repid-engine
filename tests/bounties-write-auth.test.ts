/**
 * /bounties writes: who may write, as whom, and from which state (hardening, CC1 2026-10-14).
 *
 * The router is mounted at '/', ahead of the global authMiddleware, so each write runs it:
 * no key -> 401, unknown key -> 403. On top of that:
 *   - bounty ids are uuids; authMiddleware's path-UUID-is-the-agent check must not 403 a bound key
 *   - a bound key acts as its own agent (body agentId ignored); an unbound env key needs tier 'ops'
 *   - a non-string agentId -> 400
 *   - every status move is guarded in the UPDATE and its row count checked -> 409 otherwise
 * The race tests use a stale first read: the route sees the old state, the row has moved on.
 */
import express from 'express';
import request from 'supertest';

const BOUND = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';
const VERIFIER = 'dddddddd-1111-2222-3333-444444444444';
const B1 = 'eeeeeeee-1111-2222-3333-000000000001';
const NEW_ID = 'eeeeeeee-1111-2222-3333-0000000000ff';

type Row = Record<string, any>;
const rows = new Map<string, Row>();
const writes: Array<{ op: 'insert' | 'update'; row: Row }> = [];
let staleRead: Row | null = null; // returned by the next .single(), then cleared

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table !== 'repid_bounties') {
        const o: any = { select: () => o, eq: () => o, maybeSingle: async () => ({ data: { agent_name: 'trinity-bound-agent' }, error: null }) };
        return o;
      }
      const filters: Array<[string, unknown]> = [];
      let patch: Row | null = null;
      const match = () => [...rows.values()].filter((r) => filters.every(([k, v]) => r[k] === v));
      const b: any = {
        select: () => b,
        eq: (k: string, v: unknown) => { filters.push([k, v]); return b; },
        order: () => b,
        limit: async () => ({ data: match(), error: null }),
        maybeSingle: async () => ({ data: match()[0] ?? null, error: null }),
        single: async () => {
          const r = staleRead ?? match()[0];
          staleRead = null;
          return r ? { data: { ...r }, error: null } : { data: null, error: { message: 'not found' } };
        },
        update: (p: Row) => { patch = p; return b; },
        insert: (row: Row) => {
          writes.push({ op: 'insert', row });
          return { select: () => ({ single: async () => ({ data: { id: NEW_ID }, error: null }) }) };
        },
        then: (ok: (v: unknown) => void) => {
          if (!patch) return ok({ data: match(), error: null });
          const hit = match();
          for (const r of hit) Object.assign(r, patch);
          if (hit.length) writes.push({ op: 'update', row: patch });
          return ok({ data: hit.map((r) => ({ id: r.id })), error: null });
        },
      };
      return b;
    },
  },
}));
jest.mock('../src/auth/api-keys', () => ({
  ...jest.requireActual('../src/auth/api-keys'),
  validateAgentApiKey: jest.fn(async (key: string) =>
    key === 'bound-key' ? { agent_id: BOUND, scopes: [] }
      : key === 'verifier-key' ? { agent_id: VERIFIER, scopes: ['bounty_verify'] }
        : null),
}));
jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn().mockResolvedValue(undefined) }));
// The verifier and the claimant are under different owners, so the independence check
// (bounty-authorization.ts verifierIndependence) passes and these tests see the state machine.
jest.mock('../src/services/agent-owner-resolver', () => ({
  ...jest.requireActual('../src/services/agent-owner-resolver'),
  resolveOwner: jest.fn(async (ref: { id?: string }) => {
    const claim = { source: 'binding', assurance: 'onchain', ownerKey: `owner-of-${ref.id}`, ownerKeyKind: 'wallet', capUsdcPerTx: null, capUsdcTotal: null };
    return { status: 'resolved', agentId: ref.id ?? null, owner: claim, claims: [claim], conflicts: [], reason: null, probes: [] };
  }),
}));
const updateRepId = jest.fn(async () => ({ delta: 100 }));
jest.mock('../src/engine/repid-update', () => ({ updateRepId: (...a: unknown[]) => (updateRepId as any)(...a) }));

import bountiesRouter from '../src/routes/bounties';

function app() {
  const a = express();
  a.use(express.json());
  a.use(bountiesRouter);
  return a;
}
const seed = (status: string, claimant: string | null = null) =>
  rows.set(B1, { id: B1, status, claimant_agent_id: claimant, bounty_repid: 50 });
const post = (path: string, key: string | null, body: Record<string, unknown> = {}) => {
  const q = request(app()).post(path);
  return (key ? q.set('Authorization', `Bearer ${key}`) : q).send(body);
};

beforeEach(() => {
  rows.clear();
  writes.length = 0;
  staleRead = null;
  updateRepId.mockClear();
  process.env.REPID_API_KEYS = 'plain-env-key,ops-key:ops';
});
afterAll(() => { delete process.env.REPID_API_KEYS; });

describe.each([
  { name: 'POST /bounties', path: '/bounties', body: { title: 't', description: 'd' } },
  { name: 'POST /bounties/:id/claim', path: `/bounties/${B1}/claim`, body: { agentId: BOUND } },
  { name: 'POST /bounties/:id/complete', path: `/bounties/${B1}/complete`, body: { agentId: BOUND } },
])('$name', ({ path, body }) => {
  test('no key → 401, unknown key → 403, unbound non-operator env key → 403; nothing written', async () => {
    seed('OPEN');
    expect((await post(path, null, body)).status).toBe(401);
    expect((await post(path, 'not-a-key', body)).status).toBe(403);
    expect((await post(path, 'plain-env-key', body)).status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});

describe('a bound key on a real (uuid) bounty id acts as itself', () => {
  test('claim → 200 and the claimant is the key, with no agentId in the body', async () => {
    seed('OPEN');
    const res = await post(`/bounties/${B1}/claim`, 'bound-key');
    expect(res.status).toBe(200);
    expect(rows.get(B1)).toMatchObject({ status: 'CLAIMED', claimant_agent_id: BOUND });
  });

  test('complete → 200 on its own claim', async () => {
    seed('CLAIMED', BOUND);
    const res = await post(`/bounties/${B1}/complete`, 'bound-key', { zkpProof: 'p' });
    expect(res.status).toBe(200);
    expect(rows.get(B1)).toMatchObject({ status: 'COMPLETED', zkp_completion_proof: 'p' });
  });

  test('a body agentId naming another agent → 403, nothing written', async () => {
    seed('OPEN');
    expect((await post(`/bounties/${B1}/claim`, 'bound-key', { agentId: OTHER })).status).toBe(403);
    expect(writes).toHaveLength(0);
  });

  test('a non-string agentId → 400, nothing written', async () => {
    seed('OPEN');
    expect((await post(`/bounties/${B1}/claim`, 'bound-key', { agentId: 12345 })).status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  test('POST /bounties posts as the key, whatever postedByAgentId says', async () => {
    await post('/bounties', 'bound-key', { title: 't', description: 'd', postedByAgentId: 'someone-else' });
    expect(writes[0].row).toMatchObject({ posted_by_agent_id: BOUND });
  });
});

describe('an operator (ops-tier) env key may act for a named agent', () => {
  test('claim for OTHER → 200; without agentId → 400', async () => {
    seed('OPEN');
    expect((await post(`/bounties/${B1}/claim`, 'ops-key')).status).toBe(400);
    expect((await post(`/bounties/${B1}/claim`, 'ops-key', { agentId: OTHER })).status).toBe(200);
    expect(rows.get(B1)).toMatchObject({ status: 'CLAIMED', claimant_agent_id: OTHER });
  });
});

describe('every status move is guarded; a move from the wrong state is 409 and writes nothing', () => {
  test('claim loses a race: read says OPEN, row is already CLAIMED by someone else → 409, claimant kept', async () => {
    seed('CLAIMED', OTHER);
    staleRead = { id: B1, status: 'OPEN', claimant_agent_id: null };
    const res = await post(`/bounties/${B1}/claim`, 'ops-key', { agentId: BOUND });
    expect(res.status).toBe(409);
    expect(rows.get(B1)).toMatchObject({ claimant_agent_id: OTHER });
    expect(writes).toHaveLength(0);
  });

  test('complete on a VERIFIED bounty → 409 and it stays VERIFIED (no second payout path)', async () => {
    seed('VERIFIED', BOUND);
    const res = await post(`/bounties/${B1}/complete`, 'ops-key', { agentId: BOUND });
    expect(res.status).toBe(409);
    expect(rows.get(B1)!.status).toBe('VERIFIED');
    expect(writes).toHaveLength(0);
  });

  test('complete by someone who is not the claimant → 403, not a COMPLETED that never happened', async () => {
    seed('CLAIMED', BOUND);
    const res = await post(`/bounties/${B1}/complete`, 'ops-key', { agentId: OTHER });
    expect(res.status).toBe(403);
    expect(res.body.status).toBeUndefined();
    expect(rows.get(B1)!.status).toBe('CLAIMED');
  });

  test('verify loses a race: read says COMPLETED, row already VERIFIED → 409 and no second payout', async () => {
    seed('VERIFIED', BOUND);
    staleRead = { ...rows.get(B1)!, status: 'COMPLETED' };
    const res = await post(`/bounties/${B1}/verify`, 'verifier-key', { approved: true });
    expect(res.status).toBe(409);
    expect(updateRepId).not.toHaveBeenCalled();
  });

  test('verify pays exactly once on the happy path', async () => {
    seed('COMPLETED', BOUND);
    const res = await post(`/bounties/${B1}/verify`, 'verifier-key', { approved: true });
    expect(res.status).toBe(200);
    expect(rows.get(B1)!.status).toBe('VERIFIED');
    expect(updateRepId).toHaveBeenCalledTimes(1);
  });

  test('reject loses a race: read says COMPLETED, row already VERIFIED → 409, stays VERIFIED', async () => {
    seed('VERIFIED', BOUND);
    staleRead = { ...rows.get(B1)!, status: 'COMPLETED' };
    const res = await post(`/bounties/${B1}/verify`, 'verifier-key', { approved: false });
    expect(res.status).toBe(409);
    expect(rows.get(B1)!.status).toBe('VERIFIED');
  });
});

test('reads stay public', async () => {
  expect((await request(app()).get('/bounties')).status).toBe(200);
});
