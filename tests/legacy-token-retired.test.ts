/**
 * D-108 / CLAUDE_RULES r32: one credential, one form, one verifier.
 *
 * The legacy registration token (`constitution.api_key`, or the `api_key_sha256` the S1 SQL turns it
 * into) is retired as an auth path. Agent auth is `agent_api_keys` only (hashed, one verifier:
 * validateAgentApiKey). #1400 checked the plaintext first, so a row holding both forms never looked at
 * the hash (Grok); deleting the path removes that and every other dual-form question with it.
 * Usage before deleting [V 2026-10-15]: 17 rows carry the token (16 test_only + demo-openai-agent, which
 * has 0 live modern keys); no legacy-token agent has had a score event since 2026-07-25.
 *
 * POST /agents/human stores the privateId's sha256, never the privateId, and the privateId now carries
 * 128 random bits: the old `human-<ms>-<6 base36>` was ~31 bits next to a known timestamp, so its sha256
 * in an anon-readable column would have been the plaintext with one extra step.
 */
import express from 'express';
import request from 'supertest';
import { createHash, randomUUID } from 'crypto';

jest.mock('../src/db', () => ({ db: { from: jest.fn(), rpc: jest.fn() } }));
jest.mock('../src/auth/api-keys', () => ({
  ...jest.requireActual('../src/auth/api-keys'),
  validateAgentApiKey: jest.fn(),
  issueAgentApiKey: jest.fn(async () => ({ key: 'ts_live_minted', key_prefix: 'ts_live_minted' })),
}));
// Past auth, minting needs the accountable root's signature; both say yes here, so the ONLY thing
// standing between a caller and a new key in these tests is the credential check under test.
jest.mock('../src/services/accountable-root', () => ({
  resolveAccountableRoot: jest.fn(async () => ({ ok: true, root: { wallet: '0x0000000000000000000000000000000000000001' } })),
  rootRefusalStatus: jest.fn(() => 403),
}));
jest.mock('../src/services/owner-authorization', () => ({
  checkOwnerAuthorization: jest.fn(async () => ({ ok: true })),
  readOwnerAuthorization: jest.fn(() => null),
}));
jest.mock('../src/engine/badges', () => ({
  ...jest.requireActual('../src/engine/badges'),
  suggestConstitutionalRules: jest.fn(async () => []),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { db } = require('../src/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const apiKeys = require('../src/auth/api-keys');

const AGENT = randomUUID();
const LEGACY = randomUUID();
const MODERN = 'ts_live_' + 'a'.repeat(32);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
// Both forms on one row: the exact shape #1400's check got wrong.
const legacyRow = { id: AGENT, constitution: { type: 'AGENT', api_key: LEGACY, api_key_sha256: sha(LEGACY) } };

let inserts: Array<{ table: string; row: any }> = [];
const chain = (table: string) => {
  const q: any = {};
  for (const m of ['select', 'eq', 'is', 'order', 'limit', 'update']) q[m] = () => q;
  q.insert = (row: any) => { inserts.push({ table, row }); return q; };
  q.single = async () => ({ data: table === 'repid_agents' ? legacyRow : null, error: null });
  q.then = (ok: any, bad: any) => Promise.resolve({ data: table === 'agent_api_keys' ? [] : null, error: null }).then(ok, bad);
  return q;
};

// Required at load, not inside a test: agents-external pulls in most of the engine, and that import
// would otherwise eat the first test's 5 s timeout under a parallel run.
/* eslint-disable @typescript-eslint/no-var-requires */
const keysRouter = require('../src/routes/key-management').default;
const externalRouter = require('../src/routes/agents-external').default;
const agentsRouter = require('../src/routes/agents').default;
/* eslint-enable @typescript-eslint/no-var-requires */
const keysApp = () => express().use(express.json()).use('/agents', keysRouter);
const externalApp = () => express().use(express.json()).use('/agents', externalRouter);
const agentsApp = () => express().use(express.json()).use(agentsRouter);

beforeEach(() => {
  jest.clearAllMocks();
  inserts = [];
  db.from.mockImplementation(chain);
  apiKeys.validateAgentApiKey.mockImplementation(async (k: string) => (k === MODERN ? { agent_id: AGENT, scopes: [] } : null));
});

describe('the legacy registration token no longer authenticates', () => {
  it('key management: GET /:id/keys refuses it, on a row holding plaintext AND hash', async () => {
    const res = await request(keysApp()).get(`/agents/${AGENT}/keys`).set('Authorization', `Bearer ${LEGACY}`);
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/\/api\/v1\/agent-keys/);
  });

  it('key management: POST /:id/keys mints nothing for it', async () => {
    const res = await request(keysApp()).post(`/agents/${AGENT}/keys`).set('Authorization', `Bearer ${LEGACY}`).send({ name: 'k' });
    expect(res.status).toBe(401);
    expect(apiKeys.issueAgentApiKey).not.toHaveBeenCalled();
  });

  it('it is refused exactly like any other bad key, and the agent row is never read for it', async () => {
    const legacy = await request(keysApp()).get(`/agents/${AGENT}/keys`).set('Authorization', `Bearer ${LEGACY}`);
    const junk = await request(keysApp()).get(`/agents/${AGENT}/keys`).set('Authorization', `Bearer ${randomUUID()}`);
    expect([legacy.status, legacy.body]).toEqual([junk.status, junk.body]);
    expect(db.from).not.toHaveBeenCalledWith('repid_agents');
  });

  it('agents-external: POST /:id/score-event refuses it (modern-key only already; pinned here)', async () => {
    const res = await request(externalApp()).post(`/agents/${AGENT}/score-event`).set('Authorization', `Bearer ${LEGACY}`).send({ prompt: 'p' });
    expect(res.status).toBe(401);
  });

  it('the legacy verifier is gone from the one verifier module', () => {
    expect(jest.requireActual('../src/auth/api-keys').legacyTokenMatches).toBeUndefined();
  });
});

describe('a modern agent_api_keys key still authenticates', () => {
  it('GET /:id/keys -> 200', async () => {
    const res = await request(keysApp()).get(`/agents/${AGENT}/keys`).set('Authorization', `Bearer ${MODERN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ keys: [] });
  });

  it('POST /:id/keys -> 201 and a key is minted', async () => {
    const res = await request(keysApp()).post(`/agents/${AGENT}/keys`).set('Authorization', `Bearer ${MODERN}`).send({ name: 'k' });
    expect(res.status).toBe(201);
    expect(apiKeys.issueAgentApiKey).toHaveBeenCalledWith(AGENT, 'k', []);
  });
});

describe('POST /agents/human stores no plaintext privateId', () => {
  it('stores privateId_sha256 only, returns the privateId once, and the privateId is 128 random bits', async () => {
    const res = await request(agentsApp()).post('/agents/human').send({});
    expect(res.status).toBe(201);
    const privateId: string = res.body.privateId;
    expect(privateId).toMatch(/^human-[0-9a-f]{32}$/);

    const agentRow = inserts.find((i) => i.table === 'repid_agents')!.row;
    expect(agentRow.constitution).not.toHaveProperty('privateId');
    expect(agentRow.constitution.privateId_sha256).toBe(sha(privateId));
    expect(JSON.stringify(inserts)).not.toContain(privateId);
    expect(`${res.body.message} ${res.body.warning}`).not.toMatch(/stored in constitution\.privateId|writes it into constitution/);
  });
});
