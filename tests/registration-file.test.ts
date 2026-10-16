/**
 * GET /api/v1/agents/:id/registration.json — the ERC-8004 agent registration file (D-113).
 *
 * Spec: https://github.com/ethereum/ERCs/blob/master/ERCS/erc-8004.md "Agent registration file".
 * The golden below is the whole file for one agent, so any drift from the spec shape is a diff.
 */
import express from 'express';
import request from 'supertest';

process.env.PUBLIC_ENGINE_BASE_URL = 'https://engine.test';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createAgentRegistrationRouter } = require('../src/routes/agents-registration');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const slots = require('../src/services/registration-slots') as typeof import('../src/services/registration-slots');

const UUID = 'f93cdbbe-2337-48b3-8bfd-b5b7a5c2b5c0';
const HDM = {
  id: UUID,
  agent_name: 'trinity-hdm',
  description: null,
  current_repid: 1161,
  tier: 'ESTABLISHED',
  lifecycle_status: 'active',
  erc8004_token_id: '6712',
  mint_chain_id: 84532,
};

/**
 * Supabase stand-in: answers select().eq(col, val).neq(col, val).limit(n) from `rows` with
 * PostgREST semantics (neq drops NULL), and records the eq column asked.
 */
function fakeDb(rows: Array<Record<string, unknown>>, error: { message: string } | null = null) {
  const calls: Array<[string, string]> = [];
  let hit = rows;
  const builder = {
    select: () => builder,
    eq: (col: string, val: string) => {
      calls.push([col, val]);
      hit = rows.filter((r) => r[col] === val);
      return builder;
    },
    neq: (col: string, val: string) => {
      hit = hit.filter((r) => r[col] != null && r[col] !== val);
      return builder;
    },
    limit: async (n: number) => ({ data: error ? null : hit.slice(0, n), error }),
  };
  return { db: { from: () => builder }, calls };
}

function app(rows: Array<Record<string, unknown>>, error: { message: string } | null = null) {
  const { db, calls } = fakeDb(rows, error);
  const a = express();
  a.use('/api/v1', createAgentRegistrationRouter(db));
  return { a, calls };
}

const E = 'https://engine.test/api/v1';
const GOLDEN = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'trinity-hdm',
  description: 'HyperDAG-anchored AI agent trinity-hdm',
  image: '',
  services: [
    { name: 'agent-card', endpoint: `${E}/agents/${UUID}/card` },
    { name: 'repid-proof-verify', endpoint: `${E}/proof/verify` },
    { name: 'reputation-feedback', endpoint: `${E}/agents/${UUID}/reputation/payload.json` },
  ],
  x402Support: false,
  active: true,
  registrations: [{ agentId: 6712, agentRegistry: 'eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e' }],
  supportedTrust: ['reputation'],
  hyperdag: {
    current_repid: 1161,
    tier: 'ESTABLISHED',
    verifier_package: '@hyperdag/proof-verifier@^0.1.0',
    verify_url: `${E}/proof/verify`,
    proof_endpoint: `${E}/repid/proof/:job_id`,
  },
};

afterEach(() => {
  delete process.env.REGISTRATION_SLOTS_ENABLED;
});

describe('registration.json shape', () => {
  it('matches the ERC-8004 registration-v1 structure exactly (golden)', async () => {
    const res = await request(app([HDM]).a).get(`/api/v1/agents/${UUID}/registration.json`);
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual(GOLDEN);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
  });

  it('every service is {name, endpoint} and agentId is a number', async () => {
    const res = await request(app([HDM]).a).get(`/api/v1/agents/${UUID}/registration.json`);
    for (const s of res.body.services) expect(Object.keys(s).sort()).toEqual(['endpoint', 'name']);
    expect(typeof res.body.registrations[0].agentId).toBe('number');
  });

  it('active follows lifecycle_status', async () => {
    const res = await request(app([{ ...HDM, lifecycle_status: 'retired' }]).a).get(`/api/v1/agents/${UUID}/registration.json`);
    expect(res.body.active).toBe(false);
  });
});

describe('lookup by uuid or by name', () => {
  it('a uuid queries the id column', async () => {
    const { a, calls } = app([HDM]);
    const res = await request(a).get(`/api/v1/agents/${UUID}/registration.json`);
    expect(res.status).toBe(200);
    expect(calls).toEqual([['id', UUID]]);
  });

  it('a name (as minted token URIs carry) resolves to the same file', async () => {
    const { a, calls } = app([HDM]);
    const res = await request(a).get('/api/v1/agents/trinity-hdm/registration.json');
    expect(res.status).toBe(200);
    expect(calls).toEqual([['agent_name', 'trinity-hdm']]);
    expect(res.body).toStrictEqual(GOLDEN);
  });

  it('a name matching two MINTED agents is 409, never a guess', async () => {
    const res = await request(app([HDM, { ...HDM, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }]).a).get(
      '/api/v1/agents/trinity-hdm/registration.json',
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('ambiguous_name');
  });
});

describe('unknown or unminted agent', () => {
  it('unknown agent is 404 with a JSON error', async () => {
    const res = await request(app([HDM]).a).get('/api/v1/agents/trinity-nobody/registration.json');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toBe('agent_not_found_or_not_minted');
  });

  it('an agent with no token id is 404', async () => {
    const res = await request(app([{ ...HDM, erc8004_token_id: null }]).a).get(`/api/v1/agents/${UUID}/registration.json`);
    expect(res.status).toBe(404);
  });

  it('two UNMINTED rows sharing a name read as a miss (404), not as 409', async () => {
    const twin = { ...HDM, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', erc8004_token_id: null };
    const res = await request(app([{ ...HDM, erc8004_token_id: null }, twin]).a).get('/api/v1/agents/trinity-hdm/registration.json');
    expect(res.status).toBe(404);
  });

  it('one minted and one unminted row sharing a name resolves the minted one', async () => {
    const twin = { ...HDM, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', erc8004_token_id: null };
    const res = await request(app([twin, HDM]).a).get('/api/v1/agents/trinity-hdm/registration.json');
    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual(GOLDEN);
  });
});

describe('database failure', () => {
  it('500 is a fixed string and never echoes the database message', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app([HDM], { message: 'relation "repid_agents" secret detail' }).a).get(
      `/api/v1/agents/${UUID}/registration.json`,
    );
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual({ error: 'registration_file_generation_failed' });
    expect(res.text).not.toContain('secret detail');
  });
});

describe('REGISTRATION_SLOTS_ENABLED', () => {
  it('OFF (default): no slots key anywhere', async () => {
    const res = await request(app([HDM]).a).get(`/api/v1/agents/${UUID}/registration.json`);
    expect(res.text).not.toContain('slots');
    expect('slots' in res.body.hyperdag).toBe(false);
  });

  it('ON: serves a valid empty 3-slot state, and nothing else changes', async () => {
    process.env.REGISTRATION_SLOTS_ENABLED = 'true';
    const res = await request(app([HDM]).a).get(`/api/v1/agents/${UUID}/registration.json`);
    expect(res.body.hyperdag.slots).toStrictEqual({ max: 3, head: null, current: [], history: [] });
    expect(slots.validateSlotState(res.body.hyperdag.slots)).toEqual({ ok: true });
    const { slots: _s, ...rest } = res.body.hyperdag;
    expect({ ...res.body, hyperdag: rest }).toStrictEqual(GOLDEN);
  });
});

describe('slot history chain', () => {
  type Entry = import('../src/services/registration-slots').SlotEntry;
  const ISSUER = { agentRegistry: 'eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e', agentId: 7001 };
  const entry = (slot: number, value: number, prev: string | null): Entry => ({
    slot,
    type: 'chess.rating',
    issuer: ISSUER,
    claim: { metric: 'chess.rapid', op: '>=', value },
    proof: { kind: 'eas', ref: '0x' + 'ab'.repeat(32) },
    issued_at: '2026-10-16',
    expires_at: '2027-01-14',
    prev_hash: prev,
  });

  /** slot 1, slot 2, then slot 1 replaced. */
  function history(): Entry[] {
    const a = entry(1, 1800, null);
    const b = entry(2, 1500, slots.slotEntryHash(a));
    const c = entry(1, 1900, slots.slotEntryHash(b));
    return [a, b, c];
  }

  it('a replaced slot stays in history, and the chain validates', () => {
    const h = history();
    const s = slots.slotStateFromHistory(h);
    expect(s.current.map((e) => [e.slot, e.claim.value])).toEqual([[1, 1900], [2, 1500]]);
    expect(s.history).toHaveLength(3);
    expect(s.head).toBe(slots.slotEntryHash(h[2]!));
    expect(s.head).toMatch(/^0x[0-9a-f]{64}$/);
    expect(slots.validateSlotState(s)).toEqual({ ok: true });
  });

  it('rewriting a replaced entry breaks the chain', () => {
    const s = slots.slotStateFromHistory(history());
    s.history[0] = { ...s.history[0]!, claim: { ...s.history[0]!.claim, value: 2400 } };
    expect(slots.validateSlotState(s)).toEqual({ ok: false, reason: 'history[1]: prev_hash does not match the entry before it' });
  });

  it('rewriting the last entry breaks the head', () => {
    const s = slots.slotStateFromHistory(history());
    s.history[2] = { ...s.history[2]!, expires_at: '2030-01-01' };
    expect(slots.validateSlotState(s)).toEqual({ ok: false, reason: 'head does not match the last history entry' });
  });

  it('serving a superseded entry as current fails', () => {
    const s = slots.slotStateFromHistory(history());
    s.current[0] = s.history[0]!;
    expect(slots.validateSlotState(s)).toEqual({ ok: false, reason: 'current does not match history' });
  });

  it('refuses a 4th slot, free text, and a missing expiry', () => {
    const bad = (e: Partial<Entry>) => slots.validateSlotState(slots.slotStateFromHistory([{ ...entry(1, 1800, null), ...e }]));
    expect(bad({ slot: 4 })).toMatchObject({ ok: false });
    expect(bad({ type: 'my chess rating is great' })).toMatchObject({ ok: false });
    expect(bad({ expires_at: undefined as unknown as string })).toMatchObject({ ok: false });
    expect(bad({ expires_at: '2026-10-15' })).toMatchObject({ ok: false });
  });
});
