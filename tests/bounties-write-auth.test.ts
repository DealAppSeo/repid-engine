/**
 * /bounties writes require an API key (hardening, CC1 2026-10-14).
 *
 * The bounties router is mounted at '/', ahead of the global authMiddleware, and POST /bounties,
 * /bounties/:id/claim and /bounties/:id/complete ran no auth of their own. Each now runs
 * authMiddleware: no key -> 401, unknown key -> 403, agent-bound key -> works as that agent only.
 * The GET routes stay public.
 */
import express from 'express';
import request from 'supertest';

const BOUND = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';

const inserts: Record<string, unknown>[] = [];
const updates: Record<string, unknown>[] = [];
jest.mock('../src/db', () => ({
  db: {
    from: () => {
      const b: any = {
        select: () => b,
        eq: () => b,
        order: () => b,
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: { agent_name: 'trinity-bound-agent' }, error: null }),
        single: async () => ({ data: { id: 'bounty-1', status: 'OPEN' }, error: null }),
        insert: (row: Record<string, unknown>) => {
          inserts.push(row);
          return { select: () => ({ single: async () => ({ data: { id: 'bounty-1' }, error: null }) }) };
        },
        update: (row: Record<string, unknown>) => {
          updates.push(row);
          const u: any = { eq: () => u, then: (r: any) => r({ data: null, error: null }) };
          return u;
        },
      };
      return b;
    },
  },
}));
jest.mock('../src/auth/api-keys', () => ({
  validateAgentApiKey: jest.fn(async (key: string) => (key === 'bound-key' ? { agent_id: BOUND } : null)),
}));
jest.mock('../src/engine/agent-log', () => ({ logAgentEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../src/engine/repid-update', () => ({ updateRepId: jest.fn() }));

import bountiesRouter from '../src/routes/bounties';

function app() {
  const a = express();
  a.use(express.json());
  a.use(bountiesRouter);
  return a;
}

const WRITES: Array<{ name: string; path: string; body: Record<string, unknown>; ok: number }> = [
  { name: 'POST /bounties', path: '/bounties', body: { title: 't', description: 'd' }, ok: 201 },
  { name: 'POST /bounties/:id/claim', path: '/bounties/bounty-1/claim', body: { agentId: BOUND }, ok: 200 },
  { name: 'POST /bounties/:id/complete', path: '/bounties/bounty-1/complete', body: { agentId: BOUND }, ok: 200 },
];

beforeEach(() => {
  inserts.length = 0;
  updates.length = 0;
  delete process.env.REPID_API_KEYS;
});

describe.each(WRITES)('$name', ({ path, body, ok }) => {
  test('no API key → 401, nothing written', async () => {
    const res = await request(app()).post(path).send(body);
    expect(res.status).toBe(401);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test('unknown API key → 403, nothing written', async () => {
    const res = await request(app()).post(path).set('Authorization', 'Bearer not-a-key').send(body);
    expect(res.status).toBe(403);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test('valid agent key → works', async () => {
    const res = await request(app()).post(path).set('Authorization', 'Bearer bound-key').send(body);
    expect(res.status).toBe(ok);
    expect(inserts.length + updates.length).toBe(1);
  });
});

test('an agent-bound key cannot claim in another agent\'s name (403)', async () => {
  const res = await request(app()).post('/bounties/bounty-1/claim').set('Authorization', 'Bearer bound-key').send({ agentId: OTHER });
  expect(res.status).toBe(403);
  expect(updates).toHaveLength(0);
});

test('an agent-bound key posts as itself, whatever postedByAgentId says', async () => {
  await request(app()).post('/bounties').set('Authorization', 'Bearer bound-key').send({ title: 't', description: 'd', postedByAgentId: OTHER });
  expect(inserts[0]).toMatchObject({ posted_by_agent_id: BOUND });
});

test('reads stay public', async () => {
  const res = await request(app()).get('/bounties');
  expect(res.status).toBe(200);
});
