/**
 * Only the owner's wallet widens what an owned agent may do (services/owner-authorization.ts).
 *
 * The properties that matter are the refusals: no approval, someone else's approval, an approval
 * for different settings, a stale one, a reused one — each must change nothing. And an approval
 * the chain could not check is NOT CHECKED, not a pass and not a forgery.
 */
import { Wallet, hexlify, randomBytes } from 'ethers';
import express from 'express';
import request from 'supertest';
import {
  MAX_LIFETIME_S,
  OWNER_AUTH_DOMAIN,
  OWNER_AUTH_TYPES,
  __resetOwnerAuthNonces,
  canonicalJson,
  checkOwnerAuthorization,
  paramsHash,
  type OwnerAction,
} from '../src/services/owner-authorization';

const NOW = 1_800_000_000;
const AGENT = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER = 'bbbbbbbb-1111-2222-3333-444444444444';

async function approve(w: Wallet, subject: string, action: OwnerAction, params: unknown, over: { nonce?: string; expires_at?: number } = {}) {
  const nonce = over.nonce ?? hexlify(randomBytes(32));
  const expires_at = over.expires_at ?? NOW + 300;
  const signature = await w.signTypedData(OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES, { subject, action, params: paramsHash(params), nonce, expiresAt: expires_at });
  return { signature, nonce, expires_at };
}

beforeEach(() => __resetOwnerAuthNonces());

describe('the fingerprint of the settings', () => {
  // SHARED VECTOR. trustshell's tests/owner-auth.test.ts pins the same input and the same hash, so
  // the browser and the engine cannot hash "the same settings" differently without one going red.
  const VECTOR = {
    grantor_agent_id: AGENT,
    grantee_agent_id: OTHER,
    grant_class: 'cold',
    capabilities: ['read:tool:github', 'write:tool:github'],
    caveats: [{ type: 'note', text: 'é ✓' }],
    ttl_seconds: 2592000,
    role: 'cto',
    audit_for: null,
    parent_grant_id: null,
  };
  it('canonical JSON sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson(VECTOR)).toBe(
      '{"audit_for":null,"capabilities":["read:tool:github","write:tool:github"],"caveats":[{"text":"é ✓","type":"note"}],"grant_class":"cold","grantee_agent_id":"bbbbbbbb-1111-2222-3333-444444444444","grantor_agent_id":"aaaaaaaa-1111-2222-3333-444444444444","parent_grant_id":null,"role":"cto","ttl_seconds":2592000}',
    );
    expect(paramsHash(VECTOR)).toBe('0x226126e7ded097e452dbc1a77b866a65f6de45e86d85115941b82093498a6d23');
  });
  it('key order does not change it; a different value does', () => {
    expect(paramsHash({ b: 1, a: 2 })).toBe(paramsHash({ a: 2, b: 1 }));
    expect(paramsHash({ a: ['x', 'y'] })).not.toBe(paramsHash({ a: ['y', 'x'] }));
  });
});

describe('checkOwnerAuthorization', () => {
  const owner = Wallet.createRandom();
  const params = { agent_id: AGENT, name: 'k', scopes: [] };
  const check = (auth: any, over: Partial<Parameters<typeof checkOwnerAuthorization>[0]> = {}) =>
    checkOwnerAuthorization({ subject: AGENT, action: 'keys.create', params, auth, expectedSigner: owner.address, nowS: NOW, ...over });

  it('no approval → required, and says which action', async () => {
    const r = await check(null);
    expect(r).toMatchObject({ ok: false, code: 'owner_authorization_required' });
    expect((r as any).message).toMatch(/API key/);
  });

  it("the owner's approval for exactly this passes, once", async () => {
    const auth = await approve(owner, AGENT, 'keys.create', params);
    expect(await check(auth)).toEqual({ ok: true, signer: owner.address });
    expect(await check(auth)).toMatchObject({ ok: false, code: 'replayed' });
  });

  it("someone else's wallet does not pass", async () => {
    expect(await check(await approve(Wallet.createRandom(), AGENT, 'keys.create', params))).toMatchObject({ ok: false, code: 'bad_signature' });
  });

  it('an approval for different settings, another action, or another agent does not pass', async () => {
    expect(await check(await approve(owner, AGENT, 'keys.create', { ...params, scopes: ['admin'] }))).toMatchObject({ ok: false, code: 'bad_signature' });
    expect(await check(await approve(owner, AGENT, 'grant.mint', params))).toMatchObject({ ok: false, code: 'bad_signature' });
    expect(await check(await approve(owner, OTHER, 'keys.create', params))).toMatchObject({ ok: false, code: 'bad_signature' });
  });

  it('expired, too long-lived, or a malformed nonce does not pass', async () => {
    expect(await check(await approve(owner, AGENT, 'keys.create', params, { expires_at: NOW - 1 }))).toMatchObject({ ok: false, code: 'expired' });
    expect(await check(await approve(owner, AGENT, 'keys.create', params, { expires_at: NOW + MAX_LIFETIME_S + 1 }))).toMatchObject({ ok: false, code: 'lifetime_too_long' });
    expect(await check({ ...(await approve(owner, AGENT, 'keys.create', params)), nonce: '0x1234' })).toMatchObject({ ok: false, code: 'malformed' });
  });

  it('a bad attempt does not burn the nonce of a real one', async () => {
    const real = await approve(owner, AGENT, 'keys.create', params);
    expect(await check({ ...real, signature: (await approve(Wallet.createRandom(), AGENT, 'keys.create', params, { nonce: real.nonce })).signature }))
      .toMatchObject({ ok: false, code: 'bad_signature' });
    expect(await check(real)).toMatchObject({ ok: true });
  });

  it('two requests racing with the same approval: exactly one passes', async () => {
    const auth = await approve(owner, AGENT, 'keys.create', params);
    const results = await Promise.all([check(auth), check(auth), check(auth)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('a smart-wallet owner the chain cannot be reached for is NOT CHECKED, not refused as forged', async () => {
    const r = await check(await approve(owner, AGENT, 'keys.create', params), {
      expectedSigner: '0x00000000000000000000000000000000000000aa',
      chain: { getCode: async () => { throw new Error('ECONNREFUSED'); }, call: async () => '0x' },
    });
    expect(r).toMatchObject({ ok: false, code: 'not_checked' });
  });
});

// ── Routes ──────────────────────────────────────────────────────────────────

// The routes ask services/accountable-root.ts who answers for an agent [F1]. These tests set the
// answer directly; tests/accountable-root.test.ts covers how it is worked out.
type MockRoot =
  | { ok: true; root: { kind: 'owner' | 'custodian'; agentId: string; subjectId: string; wallet: string; assurance: string; via: string; grantPath: string[] } }
  | { ok: false; code: string; message: string };
const ownerRoot = (wallet: string): MockRoot => ({
  ok: true,
  root: { kind: 'owner', agentId: AGENT, subjectId: AGENT, wallet, assurance: 'wallet-proven', via: 'own-binding', grantPath: [] },
});
const custodianRoot = (wallet: string): MockRoot => ({
  ok: true,
  root: { kind: 'custodian', agentId: AGENT, subjectId: AGENT, wallet, assurance: 'operator-assigned', via: 'own-custodian', grantPath: [] },
});
const noRoot: MockRoot = { ok: false, code: 'no_root', message: 'nobody has claimed it' };
const mockState: { root: MockRoot; builder: any } = {
  root: noRoot,
  builder: null,
};
const mockMinted: unknown[] = [];
const mockIssued: unknown[] = [];
const mockWithdrawn: unknown[] = [];

jest.mock('../src/db', () => {
  const chain = (table: string) => {
    const c: any = {
      select: () => c, eq: () => c, is: () => c, order: () => c, limit: () => c, in: () => c, gte: () => c,
      maybeSingle: () => Promise.resolve({ data: table === 'builders' ? mockState.builder : null, error: null }),
      single: () => Promise.resolve({ data: null, error: null }),
      then: (r: any) => r({ data: [], error: null }),
    };
    return c;
  };
  return { db: { from: (t: string) => chain(t), rpc: () => Promise.resolve({ data: null, error: null }) } };
});
jest.mock('../src/services/accountable-root', () => ({
  ...jest.requireActual('../src/services/accountable-root'),
  resolveAccountableRoot: jest.fn(async () => mockState.root),
}));
jest.mock('../src/services/principal-grants', () => ({
  ...jest.requireActual('../src/services/principal-grants'),
  mintGrant: jest.fn(async (req: unknown) => { mockMinted.push(req); return { ok: true, grant: { id: 'g1' } }; }),
}));
jest.mock('../src/auth/api-keys', () => ({
  ...jest.requireActual('../src/auth/api-keys'),
  validateAgentApiKey: jest.fn(async (k: string) => (k === 'admin-key' ? { agent_id: AGENT, scopes: ['admin'] } : null)),
  issueAgentApiKey: jest.fn(async (...a: unknown[]) => { mockIssued.push(a); return { key: 'ts_live_new', key_prefix: 'ts_live_' }; }),
}));
jest.mock('../src/services/stake-vault', () => ({
  ...jest.requireActual('../src/services/stake-vault'),
  withdrawStake: jest.fn(async (...a: unknown[]) => { mockWithdrawn.push(a); return { ok: true }; }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mvpRouter = require('../src/routes/mvp-api').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const keysRouter = require('../src/routes/key-management').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const v1Router = require('../src/routes/v1').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { grantApprovalParams } = require('../src/routes/mvp-api');

function app(router: any, mount = '/api/v1') {
  const a = express();
  a.use(express.json());
  a.use(mount, router);
  return a;
}

describe('POST /grants', () => {
  const owner = Wallet.createRandom();
  const base = { grantor_agent_id: AGENT, grantee_agent_id: OTHER, grant_class: 'cold', ttl_seconds: 3600 };
  beforeEach(() => { mockMinted.length = 0; mockState.root = ownerRoot(owner.address); });

  it('a read-only cold grant — every starter belt — needs nothing more than today', async () => {
    const res = await request(app(mvpRouter)).post('/api/v1/grants').send({ ...base, capabilities: ['read:tool:github'] });
    expect(res.status).toBe(201);
    expect(mockMinted).toHaveLength(1);
  });

  it("widening an OWNED agent's grant without the owner's approval mints nothing", async () => {
    const res = await request(app(mvpRouter)).post('/api/v1/grants').send({ ...base, capabilities: ['write:tool:github'] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'owner_authorization_required', owner_wallet: owner.address });
    expect(mockMinted).toHaveLength(0);
  });

  it("with the owner's approval over exactly these settings, it proceeds", async () => {
    const body = { ...base, capabilities: ['write:tool:github', 'read:tool:github'] };
    const params = grantApprovalParams({ ...body, ttl_seconds: 3600 });
    const now = Math.floor(Date.now() / 1000);
    const owner_authorization = await approve(owner, AGENT, 'grant.mint', params, { expires_at: now + 300 });
    const res = await request(app(mvpRouter)).post('/api/v1/grants').send({ ...body, owner_authorization });
    expect(res.status).toBe(201);
    expect(mockMinted).toHaveLength(1);
  });

  it('an approval for read access cannot be replayed to get write access', async () => {
    const now = Math.floor(Date.now() / 1000);
    const forRead = await approve(owner, AGENT, 'grant.mint', grantApprovalParams({ ...base, capabilities: ['read:tool:github'] }), { expires_at: now + 300 });
    const res = await request(app(mvpRouter)).post('/api/v1/grants').send({ ...base, capabilities: ['write:tool:github'], owner_authorization: forRead });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('bad_signature');
    expect(mockMinted).toHaveLength(0);
  });

  it('a class above cold also needs the owner', async () => {
    const res = await request(app(mvpRouter)).post('/api/v1/grants').send({ ...base, grant_class: 'warm', capabilities: ['read:tool:github'] });
    expect(res.status).toBe(403);
    expect(mockMinted).toHaveLength(0);
  });

  it('[F1] an agent nobody answers for can no longer widen anything (before F1 it kept "today\'s rules")', async () => {
    mockState.root = noRoot;
    const res = await request(app(mvpRouter)).post('/api/v1/grants').send({ ...base, capabilities: ['write:tool:github'] });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: 'no_accountable_root', code: 'no_root' });
    expect(mockMinted).toHaveLength(0);
  });

  it('[F1] ...but a read-only belt from it still mints: reading carries no power', async () => {
    mockState.root = noRoot;
    const res = await request(app(mvpRouter)).post('/api/v1/grants').send({ ...base, capabilities: ['read:tool:github'] });
    expect(res.status).toBe(201);
  });

  it('[F1] when who answers could not be read, it is 503 NOT CHECKED and nothing is minted', async () => {
    mockState.root = { ok: false, code: 'not_checked', message: 'db down' };
    const res = await request(app(mvpRouter)).post('/api/v1/grants').send({ ...base, capabilities: ['write:tool:github'] });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('root_not_checked');
    expect(mockMinted).toHaveLength(0);
  });

  it('a name shared by several agents must be given as an id', async () => {
    mockState.root = { ok: false, code: 'ambiguous', message: 'more than one agent is named my-pai' };
    const res = await request(app(mvpRouter)).post('/api/v1/grants').send({ ...base, grantor_agent_id: 'my-pai', capabilities: ['write:tool:github'] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ambiguous');
    expect(mockMinted).toHaveLength(0);
  });

  it("[F1] a house agent held by the operator's custodian widens only with the custodian's approval", async () => {
    const custodian = Wallet.createRandom();
    mockState.root = custodianRoot(custodian.address);
    const body = { ...base, capabilities: ['write:tool:github'] };
    const denied = await request(app(mvpRouter)).post('/api/v1/grants').send(body);
    expect(denied.status).toBe(403);
    expect(denied.body.owner_wallet).toBe(custodian.address);
    const now = Math.floor(Date.now() / 1000);
    const owner_authorization = await approve(custodian, AGENT, 'grant.mint', grantApprovalParams({ ...body, ttl_seconds: 3600 }), { expires_at: now + 300 });
    const ok = await request(app(mvpRouter)).post('/api/v1/grants').send({ ...body, owner_authorization });
    expect(ok.status).toBe(201);
  });
});

describe('POST /agents/:id/keys', () => {
  const owner = Wallet.createRandom();
  const post = (body: any) =>
    request(app(keysRouter, '/api/v1/agents')).post(`/api/v1/agents/${AGENT}/keys`).set('authorization', 'Bearer admin-key').send(body);
  beforeEach(() => { mockIssued.length = 0; });

  it('[F1] an agent nobody answers for: no second key until it is claimed (before F1 the admin key alone issued one)', async () => {
    mockState.root = noRoot;
    const res = await post({ name: 'k' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_accountable_root');
    expect(mockIssued).toHaveLength(0);
  });

  it("[F1] a house agent held by the operator's custodian: the operator's admin credential issues", async () => {
    mockState.root = custodianRoot(Wallet.createRandom().address);
    expect((await post({ name: 'k' })).status).toBe(201);
    expect(mockIssued).toHaveLength(1);
  });

  it('[F1] who answers could not be read: 503, no key', async () => {
    mockState.root = { ok: false, code: 'not_checked', message: 'db down' };
    expect((await post({ name: 'k' })).status).toBe(503);
    expect(mockIssued).toHaveLength(0);
  });

  it('an OWNED agent: a key cannot mint another key without the owner', async () => {
    mockState.root = ownerRoot(owner.address);
    const res = await post({ name: 'k' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner_authorization_required');
    expect(mockIssued).toHaveLength(0);
  });

  it("an OWNED agent: with the owner's approval it issues", async () => {
    mockState.root = ownerRoot(owner.address);
    const now = Math.floor(Date.now() / 1000);
    const owner_authorization = await approve(owner, AGENT, 'keys.create', { agent_id: AGENT, name: 'k', scopes: ['admin'] }, { expires_at: now + 300 });
    const res = await post({ name: 'k', scopes: ['admin'], owner_authorization });
    expect(res.status).toBe(201);
    expect(mockIssued).toHaveLength(1);
  });
});

describe('POST /stake/withdraw', () => {
  const owner = Wallet.createRandom();
  beforeEach(() => {
    mockWithdrawn.length = 0;
    process.env.REPID_API_KEYS = 'operator-key:pro';
    mockState.builder = { id: 'b1', address: owner.address };
  });

  it('an agent key alone — or no proof at all — withdraws nothing', async () => {
    const res = await request(app(v1Router)).post('/api/v1/stake/withdraw').set('x-api-key', 'some-agent-key').send({ builder_id: 'b1', amount: '100' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('owner_authorization_required');
    expect(mockWithdrawn).toHaveLength(0);
  });

  it("the account's wallet approving this exact amount withdraws", async () => {
    const now = Math.floor(Date.now() / 1000);
    const owner_authorization = await approve(owner, 'b1', 'stake.withdraw', { builder_id: 'b1', amount: '100' }, { expires_at: now + 300 });
    const res = await request(app(v1Router)).post('/api/v1/stake/withdraw').send({ builder_id: 'b1', amount: '100', owner_authorization });
    expect(res.status).toBe(200);
    expect(mockWithdrawn).toHaveLength(1);
  });

  it('an approval for 100 does not withdraw 1000', async () => {
    const now = Math.floor(Date.now() / 1000);
    const owner_authorization = await approve(owner, 'b1', 'stake.withdraw', { builder_id: 'b1', amount: '100' }, { expires_at: now + 300 });
    const res = await request(app(v1Router)).post('/api/v1/stake/withdraw').send({ builder_id: 'b1', amount: '1000', owner_authorization });
    expect(res.status).toBe(403);
    expect(mockWithdrawn).toHaveLength(0);
  });

  it('an email-only account has no wallet to sign with, and is told so', async () => {
    mockState.builder = { id: 'b1', address: 'email:someone' };
    const res = await request(app(v1Router)).post('/api/v1/stake/withdraw').send({ builder_id: 'b1', amount: '100' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('no_wallet_to_sign');
  });

  it('an operator key still works for the harness', async () => {
    const res = await request(app(v1Router)).post('/api/v1/stake/withdraw').set('x-api-key', 'operator-key').send({ builder_id: 'b1', amount: '100' });
    expect(res.status).toBe(200);
    expect(mockWithdrawn).toHaveLength(1);
  });
});
