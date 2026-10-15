/**
 * S1 2026-10-15: repid_agents.constitution held credentials and was served to callers.
 *   - constitution.api_key is the LEGACY registration token: key-management's requireAdminAuth
 *     accepts it, and POST /agents/:id/keys then mints that agent a key. 17 rows carried one.
 *   - constitution.privateId is a human's private id (POST /agents/human). 6 rows.
 * GET /agents and GET /agents/:id returned the constitution whole to ANY key, and the public
 * register hands out keys. The anon role can read the column too (that is the SQL half, see
 * E:\dev\reports\2026-10-15\CONSTITUTION_SECRETS_2026-10-15.sql). These pin the code half: the
 * routes strip credential fields, and the legacy check accepts the sha256 that replaces the plaintext.
 */
import express from 'express';
import request from 'supertest';
import { createHash, randomUUID } from 'crypto';

jest.mock('../src/db', () => ({ db: { from: jest.fn(), rpc: jest.fn() } }));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { db } = require('../src/db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const agentsRouter = require('../src/routes/agents').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { legacyTokenMatches, publicConstitution } = require('../src/auth/api-keys');

const TOKEN = randomUUID();
const PRIVATE_ID = randomUUID();
const HOOK = randomUUID();
const constitution = { type: 'AGENT', bio: 'reviews code', rules: { r1: 'x' }, api_key: TOKEN, privateId: PRIVATE_ID };
const row = { id: 'a1', agent_name: 'demo', current_repid: 600, tier: 'EARNING', webhook_secret: HOOK, webhook_url: 'https://example.test/h', constitution };

/** A thenable query chain: every builder method returns itself, awaiting it yields `result`. */
const chain = (result: unknown) => {
  const q: any = {};
  for (const m of ['select', 'order', 'range', 'eq', 'neq', 'ilike', 'limit']) q[m] = () => q;
  q.single = async () => result;
  q.then = (ok: any, bad: any) => Promise.resolve(result).then(ok, bad);
  return q;
};

const app = () => express().use(express.json()).use(agentsRouter);

beforeEach(() => jest.clearAllMocks());

describe('routes never serve a credential', () => {
  it('GET /agents: constitution without api_key / privateId; display fields kept', async () => {
    db.from.mockReturnValue(chain({ data: [row], error: null }));
    const res = await request(app()).get('/agents');
    expect(res.status).toBe(200);
    expect(res.body[0].constitution).toEqual({ type: 'AGENT', bio: 'reviews code', rules: { r1: 'x' } });
    expect(res.body[0].bio).toBe('reviews code');
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(JSON.stringify(res.body)).not.toContain(PRIVATE_ID);
  });

  it('GET /agents/:id: the row without webhook_secret and without constitution credentials', async () => {
    db.from.mockReturnValue(chain({ data: row, error: null }));
    const res = await request(app()).get('/agents/a1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'a1', agent_name: 'demo', webhook_url: 'https://example.test/h' });
    expect(res.body).not.toHaveProperty('webhook_secret');
    for (const v of [TOKEN, PRIVATE_ID, HOOK]) expect(JSON.stringify(res.body)).not.toContain(v);
  });

  it('publicConstitution also drops the hashes that replace the plaintext, and leaves non-objects alone', () => {
    expect(publicConstitution({ bio: 'b', api_key_sha256: 'h', privateId_sha256: 'h' })).toEqual({ bio: 'b' });
    expect(publicConstitution(null)).toBeNull();
    expect(publicConstitution(undefined)).toBeNull();
  });
});

describe('legacyTokenMatches: the plaintext today, its sha256 after the SQL', () => {
  const sha = createHash('sha256').update(TOKEN).digest('hex');

  it('accepts the plaintext token', () => expect(legacyTokenMatches({ api_key: TOKEN }, TOKEN)).toBe(true));
  it('accepts the token against its stored sha256', () => expect(legacyTokenMatches({ api_key_sha256: sha }, TOKEN)).toBe(true));
  it('refuses a wrong token, the hash itself presented as a token, and empty input', () => {
    expect(legacyTokenMatches({ api_key_sha256: sha }, randomUUID())).toBe(false);
    expect(legacyTokenMatches({ api_key_sha256: sha }, sha)).toBe(false);
    expect(legacyTokenMatches({ api_key: '' }, '')).toBe(false);
    expect(legacyTokenMatches(null, TOKEN)).toBe(false);
    expect(legacyTokenMatches({}, TOKEN)).toBe(false);
  });
});
