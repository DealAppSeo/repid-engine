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
const NESTED = randomUUID();
const constitution = {
  type: 'AGENT', bio: 'reviews code', rules: { r1: 'x', api_key: NESTED }, api_key: TOKEN, privateId: PRIVATE_ID,
  // Names a denylist never thought of (XC1 on #1397): the allowlist drops them because nobody listed them.
  pin: NESTED, passphrase: NESTED, bearer: NESTED,
};
const row = {
  id: 'a1', agent_name: 'demo', current_repid: 600, tier: 'EARNING', webhook_secret: HOOK, webhook_url: 'https://example.test/h',
  constitution_text: NESTED, wallet_address: '0xabc', constitution,
};

/**
 * A thenable query chain standing in for supabase-js. Like the real one, a `.select(cols)` returns only
 * those columns, so a route that asks for too much is caught by what comes back. `selected` keeps
 * every column list asked for.
 */
let selected: string[] = [];
const chain = (data: Record<string, unknown> | Record<string, unknown>[]) => {
  let cols: string[] | null = null;
  const pick = (r: Record<string, unknown>) => (cols ? Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])) : r);
  const result = () => ({ data: Array.isArray(data) ? data.map(pick) : pick(data), error: null });
  const q: any = {};
  for (const m of ['order', 'range', 'eq', 'neq', 'ilike', 'limit']) q[m] = () => q;
  q.select = (s: string) => {
    selected.push(s);
    cols = s.trim() === '*' ? null : s.split(',').map((c) => c.trim());
    return q;
  };
  q.single = async () => result();
  q.then = (ok: any, bad: any) => Promise.resolve(result()).then(ok, bad);
  return q;
};

const app = () => express().use(express.json()).use(agentsRouter);

beforeEach(() => { jest.clearAllMocks(); selected = []; });

describe('routes never serve a credential', () => {
  it('GET /agents: constitution without api_key / privateId; display fields kept', async () => {
    db.from.mockReturnValue(chain([row]));
    const res = await request(app()).get('/agents');
    expect(res.status).toBe(200);
    expect(res.body[0].constitution).toEqual({ type: 'AGENT', bio: 'reviews code' });
    expect(res.body[0].bio).toBe('reviews code');
    expect(res.body[0].ruleCount).toBe(2);
    for (const v of [TOKEN, PRIVATE_ID, NESTED]) expect(JSON.stringify(res.body)).not.toContain(v);
  });

  it('GET /agents/:id: selects explicit public columns, never * (no constitution_text, webhook or wallet fields)', async () => {
    db.from.mockReturnValue(chain(row));
    const res = await request(app()).get('/agents/a1');
    expect(res.status).toBe(200);
    expect(selected).toHaveLength(1);
    expect(selected[0]).not.toMatch(/\*|constitution_text|webhook|wallet_address|signing_address|conservator|byok/);
    expect(res.body).toMatchObject({ id: 'a1', agent_name: 'demo', current_repid: 600, tier: 'EARNING' });
    expect(res.body.constitution).toEqual({ type: 'AGENT', bio: 'reviews code' });
    for (const f of ['webhook_secret', 'webhook_url', 'constitution_text', 'wallet_address']) expect(res.body).not.toHaveProperty(f);
    for (const v of [TOKEN, PRIVATE_ID, HOOK, NESTED]) expect(JSON.stringify(res.body)).not.toContain(v);
  });

  it('publicConstitution keeps only allowlisted scalar fields', () => {
    expect(publicConstitution({ bio: 'b', version: '1', anonymous: false, api_key_sha256: 'h', privateId_sha256: 'h', token_hint: 'x' }))
      .toEqual({ bio: 'b', version: '1', anonymous: false });
    // An allowlisted name holding an object is not a scalar, so it is not served either.
    expect(publicConstitution({ bio: { api_key: NESTED } })).toEqual({});
    expect(publicConstitution(null)).toBeNull();
    expect(publicConstitution(undefined)).toBeNull();
    expect(publicConstitution(['x'])).toBeNull();
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
  it('a malformed stored hash refuses instead of throwing (timingSafeEqual needs equal lengths)', () => {
    expect(legacyTokenMatches({ api_key_sha256: 'abc' }, TOKEN)).toBe(false);
    expect(legacyTokenMatches({ api_key_sha256: 'z'.repeat(64) }, TOKEN)).toBe(false);
    expect(legacyTokenMatches({ api_key: TOKEN }, undefined as unknown as string)).toBe(false);
  });
});
