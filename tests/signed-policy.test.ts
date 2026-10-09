/**
 * POST /api/v1/policies, POST /api/v1/policies/revoke, GET /api/v1/policies/:hash, and the
 * verify-by-stored-policy extension of POST /api/v1/jobs/verify — the TrustKeys reference-tier
 * POLICY LIFECYCLE (registry + revocation), stacked on PR #1273.
 *
 * These pin the honest contract:
 *   - register a signed policy → stored, content hash returned; a second identical register is
 *     idempotent (same hash, one row);
 *   - revoke by the owner → revoked; a subsequent verify-by-stored → no_active_policy;
 *   - revoke by a non-owner → not_owner (403); revoke a missing policy → policy_not_found (404);
 *     a reused revocation nonce → replay (409);
 *   - GET returns ONLY non-secret fields, including the revoked boolean, and NO signature/nonce;
 *   - verify-by-stored (no inline policy) resolves the active policy and enforces cap/payee EXACTLY
 *     as the inline path; an expired active policy is not active;
 *   - every DB error on every route REFUSES as not_checked (503), never a pass, and never leaks the
 *     raw error;
 *   - flag OFF → 404 with NO database read;
 *   - NO key / secret / RAW PAYEE ADDRESS ever appears — a policy is addresses-as-hashes + a cap.
 *
 * Real signatures are produced with ethers Wallet (EOA), verified with no network by the jest
 * offline-signature-chain setup. The DB is an in-memory mock, same shape as tests/signed-job-verify.ts.
 */

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SIGNED_JOB_VERIFY_ENABLED'] as const;
const ENV_SNAPSHOT: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ENV_SNAPSHOT[k] = process.env[k];
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'dummy';
process.env.SIGNED_JOB_VERIFY_ENABLED = 'true'; // default-on for the suite; the flag-off test flips it
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (ENV_SNAPSHOT[k] === undefined) delete process.env[k];
    else process.env[k] = ENV_SNAPSHOT[k];
  }
  delete (globalThis as any).__SP_STORE__;
  delete (globalThis as any).__SP_FAIL__;
  delete (globalThis as any).__SP_META__;
});

jest.mock('../src/db', () => {
  const store: Record<string, any[]> = {
    signed_policies: [],
    human_agent_bindings: [],
    repid_agents: [],
    signed_job_receipts: [],
  };
  const meta = { fromCalls: 0 };
  (globalThis as any).__SP_META__ = meta;
  const tbl = (name: string): any[] => (store[name] ||= []);
  const fail = () => (globalThis as any).__SP_FAIL__ as { table?: string; op?: string; code?: string; message?: string } | null;

  class Q {
    table: string;
    private _filters: Array<(r: any) => boolean> = [];
    private _op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    private _payload: any = null;
    private _single = false;
    private _maybe = false;
    private _selected = false;
    private _order: { col: string; asc: boolean } | null = null;
    private _limit: number | null = null;
    constructor(table: string) { this.table = table; }
    select() { this._selected = true; return this; }
    eq(col: string, val: any) { this._filters.push((r) => r[col] === val); return this; }
    ilike(col: string, val: any) { const v = String(val).toLowerCase(); this._filters.push((r) => String(r[col] ?? '').toLowerCase() === v); return this; }
    in(col: string, vals: any[]) { this._filters.push((r) => vals.includes(r[col])); return this; }
    is(col: string, val: any) { this._filters.push((r) => (r[col] ?? null) === val); return this; }
    gt(col: string, val: any) { this._filters.push((r) => Number(r[col]) > Number(val)); return this; }
    gte(col: string, val: any) { this._filters.push((r) => Number(r[col]) >= Number(val)); return this; }
    lte() { return this; } lt() { return this; } not() { return this; }
    order(col: string, opts?: { ascending?: boolean }) { this._order = { col, asc: opts?.ascending !== false }; return this; }
    limit(n: number) { this._limit = n; return this; }
    range() { return this; }
    maybeSingle() { this._maybe = true; return this; }
    single() { this._single = true; return this; }
    insert(payload: any) { this._op = 'insert'; this._payload = payload; return this; }
    update(payload: any) { this._op = 'update'; this._payload = payload; return this; }
    delete() { this._op = 'delete'; return this; }
    private _exec(): { data: any; error: any; count?: number } {
      const f = fail();
      if (f && f.table === this.table && (!f.op || f.op === this._op)) {
        return { data: null, error: { message: f.message ?? 'boom', code: f.code } };
      }
      const t = tbl(this.table);
      if (this._op === 'insert') {
        const row = { ...this._payload };
        // signed_policies PRIMARY KEY (policy_hash) — a re-register of the same policy conflicts.
        if (this.table === 'signed_policies' && t.some((r) => r.policy_hash === row.policy_hash)) {
          return { data: null, error: { message: 'duplicate key value violates unique constraint "signed_policies_pkey"', code: '23505' } };
        }
        // signed_job_receipts UNIQUE(owner, nonce) — the job replay guard (#1273).
        if (this.table === 'signed_job_receipts' && t.some((r) => r.owner === row.owner && r.nonce === row.nonce)) {
          return { data: null, error: { message: 'duplicate key value violates unique constraint "signed_job_receipts_owner_nonce_key"', code: '23505' } };
        }
        if (row.id === undefined) row.id = `${this.table}-${t.length + 1}`;
        if (row.created_at === undefined) row.created_at = new Date().toISOString();
        t.push(row);
        if (this._selected || this._single || this._maybe) return { data: row, error: null };
        return { data: null, error: null };
      }
      let rows = t.filter((r) => this._filters.every((fn) => fn(r)));
      if (this._op === 'update') {
        // signed_policies UNIQUE(owner, revocation_nonce) — the revoke replay guard. A nonce already
        // stamped on another of this owner's policies refuses, exactly as the DB index would.
        if (this.table === 'signed_policies' && this._payload.revocation_nonce != null) {
          const nonce = this._payload.revocation_nonce;
          for (const m of rows) {
            if (t.some((x) => !rows.includes(x) && x.owner === m.owner && x.revocation_nonce === nonce)) {
              return { data: null, error: { message: 'duplicate key value violates unique constraint "signed_policies_owner_revocation_nonce_key"', code: '23505' } };
            }
          }
        }
        rows.forEach((r) => Object.assign(r, this._payload));
        return { data: rows, error: null };
      }
      if (this._op === 'delete') { for (const r of rows) { const i = t.indexOf(r); if (i >= 0) t.splice(i, 1); } return { data: null, error: null }; }
      if (this._order) {
        const { col, asc } = this._order;
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (this._limit != null) rows = rows.slice(0, this._limit);
      if (this._single) return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows', code: 'PGRST116' } };
      if (this._maybe) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null, count: rows.length };
    }
    then(onF?: (v: any) => any, onR?: (e: any) => any) { return Promise.resolve(this._exec()).then(onF, onR); }
    catch(onR: (e: any) => any) { return this.then(undefined, onR); }
    finally(fn: () => void) { return this.then().finally(fn); }
  }
  const db = { from: (table: string) => { meta.fromCalls++; return new Q(table); } };
  (globalThis as any).__SP_STORE__ = store;
  return { db };
});

import express from 'express';
import request from 'supertest';
import { Wallet } from 'ethers';
import { canonicalJson, hashPayee } from '../src/services/signed-job';
import { computePolicyHash } from '../src/services/signed-policy';

type Store = Record<string, any[]>;
const store = (): Store => (globalThis as any).__SP_STORE__;
const meta = (): { fromCalls: number } => (globalThis as any).__SP_META__;

// The production SQL-keyword body sanitizer (src/index.ts), mirrored so the suite proves a realistic
// policy/revocation payload survives it.
const FORBIDDEN = ['SELECT ', 'DROP ', 'INSERT ', 'UPDATE ', 'DELETE ', '--', ';'];
function sqlKeywordSanitizer(req: any, res: any, next: any) {
  if (req.method !== 'POST') return next();
  const scan = (obj: any): boolean => {
    for (const key in obj) {
      const val = obj[key];
      if (typeof val === 'string') {
        if (FORBIDDEN.some((kw) => val.toUpperCase().includes(kw))) return false;
      } else if (val && typeof val === 'object') {
        if (!scan(val)) return false;
      }
    }
    return true;
  };
  return scan(req.body) ? next() : res.status(400).json({ error: 'Validation failed' });
}

let app: express.Express;
const PAYEE = '0x' + 'b'.repeat(40);
const PAYEE_HASH = hashPayee(PAYEE);
const CHAIN_ID = 84532;

function reset() {
  const s = store();
  for (const k of Object.keys(s)) s[k].length = 0;
  meta().fromCalls = 0;
  (globalThis as any).__SP_FAIL__ = null;
}

function seedOwnerAgent(ownerLower: string, repid: number, agentId = 'agent-x') {
  store().human_agent_bindings.push({ id: 'bind-1', agent_id: agentId, human_wallet: ownerLower, scope: 'ownership', revoked_at: null });
  store().repid_agents.push({ id: agentId, agent_name: 'Owned Agent', current_repid: repid });
}

let nonceSeq = 0;
const freshNonce = () => '0x' + (++nonceSeq).toString(16).padStart(32, '0');

function makePolicy(ownerLower: string, over: Partial<Record<string, any>> = {}) {
  return {
    v: 1,
    type: 'trustkeys-policy',
    owner: ownerLower,
    chain_id: CHAIN_ID,
    cap: '1000000000', // 1000 tokens (6-decimal)
    token: 'USDC',
    payee_hashes: [PAYEE_HASH],
    expiry: Math.floor(Date.now() / 1000) + 3600,
    policy_nonce: '0x' + 'ab'.repeat(16),
    ...over,
  };
}
function makeJob(ownerLower: string, over: Partial<Record<string, any>> = {}) {
  return {
    v: 1,
    type: 'trustkeys-job',
    owner: ownerLower,
    chain_id: CHAIN_ID,
    action: 'spend',
    cap: '1000000', // 1 token
    payee_hash: PAYEE_HASH,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    nonce: freshNonce(),
    ...over,
  };
}
function makeRevocation(ownerLower: string, policyHash: string, over: Partial<Record<string, any>> = {}) {
  return {
    v: 1,
    type: 'trustkeys-policy-revoke',
    owner: ownerLower,
    policy_hash: policyHash,
    nonce: freshNonce(),
    expiry: Math.floor(Date.now() / 1000) + 3600,
    ...over,
  };
}
const sign = (w: Wallet, obj: unknown) => w.signMessage(canonicalJson(obj));

const postPolicy = (body: unknown) => request(app).post('/api/v1/policies').send(body as any);
const postRevoke = (body: unknown) => request(app).post('/api/v1/policies/revoke').send(body as any);
const getPolicy = (hash: string) => request(app).get(`/api/v1/policies/${hash}`);
const postVerify = (body: unknown) => request(app).post('/api/v1/jobs/verify').send(body as any);

/** Register a valid policy for `owner`, returning its hash. */
async function register(owner: Wallet, policyOver = {}) {
  const policy = makePolicy(owner.address.toLowerCase(), policyOver);
  const r = await postPolicy({ policy, policy_signature: await sign(owner, policy) });
  expect(r.status).toBe(200);
  return { hash: r.body.policy_hash as string, policy };
}

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const policiesRouter = require('../src/routes/v1/policies').default;
  const jobsRouter = require('../src/routes/v1/jobs').default;
  /* eslint-enable @typescript-eslint/no-var-requires */
  app = express();
  app.use(express.json());
  app.use(sqlKeywordSanitizer);
  app.use('/api/v1', policiesRouter);
  app.use('/api/v1', jobsRouter);
});
beforeEach(() => reset());

describe('POST /policies — register', () => {
  it('valid policy → stored, content hash returned (matches computePolicyHash)', async () => {
    const owner = Wallet.createRandom();
    const policy = makePolicy(owner.address.toLowerCase());
    const r = await postPolicy({ policy, policy_signature: await sign(owner, policy) });
    expect(r.status).toBe(200);
    expect(r.body.registered).toBe(true);
    expect(r.body.policy_hash).toBe(computePolicyHash(policy as any));
    expect(store().signed_policies).toHaveLength(1);
    const row = store().signed_policies[0];
    expect(row.owner).toBe(owner.address.toLowerCase());
    expect(row.policy_hash).toBe(r.body.policy_hash);
    expect(row.revoked_at ?? null).toBeNull();
  });

  it('register is idempotent on the content hash (same hash, one row)', async () => {
    const owner = Wallet.createRandom();
    const policy = makePolicy(owner.address.toLowerCase());
    const sig = await sign(owner, policy);
    const r1 = await postPolicy({ policy, policy_signature: sig });
    const r2 = await postPolicy({ policy, policy_signature: sig });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r2.body.idempotent).toBe(true);
    expect(r2.body.policy_hash).toBe(r1.body.policy_hash);
    expect(store().signed_policies).toHaveLength(1);
  });

  it('wrong signer → signature_mismatch (401), nothing stored', async () => {
    const owner = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const policy = makePolicy(owner.address.toLowerCase());
    const r = await postPolicy({ policy, policy_signature: await sign(attacker, policy) });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('signature_mismatch');
    expect(store().signed_policies).toHaveLength(0);
  });

  it('expired policy → expired (401)', async () => {
    const owner = Wallet.createRandom();
    const policy = makePolicy(owner.address.toLowerCase(), { expiry: Math.floor(Date.now() / 1000) - 10 });
    const r = await postPolicy({ policy, policy_signature: await sign(owner, policy) });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('expired');
  });

  it('a realistic register payload passes the SQL-keyword sanitizer', async () => {
    const owner = Wallet.createRandom();
    const policy = makePolicy(owner.address.toLowerCase());
    const body = { policy, policy_signature: await sign(owner, policy) };
    const serialized = JSON.stringify(body).toUpperCase();
    for (const kw of FORBIDDEN) expect(serialized.includes(kw)).toBe(false);
    const r = await postPolicy(body);
    expect(r.status).toBe(200);
  });

  it('register DB error → not_checked (503); raw error not returned', async () => {
    const owner = Wallet.createRandom();
    (globalThis as any).__SP_FAIL__ = { table: 'signed_policies', op: 'insert', code: '08006', message: 'connection reset by peer' };
    const policy = makePolicy(owner.address.toLowerCase());
    const r = await postPolicy({ policy, policy_signature: await sign(owner, policy) });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('not_checked');
    expect(JSON.stringify(r.body)).not.toContain('connection reset by peer');
  });
});

describe('POST /policies/revoke — revoke', () => {
  it('revoke by owner → revoked; a subsequent verify-by-stored → no_active_policy', async () => {
    const owner = Wallet.createRandom();
    const ownerLower = owner.address.toLowerCase();
    seedOwnerAgent(ownerLower, 5000);
    const { hash } = await register(owner);

    // active before revoke: verify-by-stored (no inline policy) resolves + passes
    const job0 = makeJob(ownerLower);
    const beforeOk = await postVerify({ job: job0, job_signature: await sign(owner, job0) });
    expect(beforeOk.status).toBe(200);
    expect(beforeOk.body.verified).toBe(true);

    const rev = makeRevocation(ownerLower, hash);
    const r = await postRevoke({ revocation: rev, revocation_signature: await sign(owner, rev) });
    expect(r.status).toBe(200);
    expect(r.body.revoked).toBe(true);
    expect(store().signed_policies[0].revoked_at).toBeTruthy();

    const job1 = makeJob(ownerLower);
    const after = await postVerify({ job: job1, job_signature: await sign(owner, job1) });
    expect(after.status).toBe(404);
    expect(after.body.error).toBe('no_active_policy');
  });

  it('revoke by a non-owner → not_owner (403), policy stays active', async () => {
    const owner = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const { hash } = await register(owner);
    // attacker names themselves as owner and signs validly, but targets the owner's policy_hash
    const rev = makeRevocation(attacker.address.toLowerCase(), hash);
    const r = await postRevoke({ revocation: rev, revocation_signature: await sign(attacker, rev) });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('not_owner');
    expect(store().signed_policies[0].revoked_at ?? null).toBeNull();
  });

  it('wrong signer (claims owner, signed by other) → signature_mismatch (401)', async () => {
    const owner = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const { hash } = await register(owner);
    const rev = makeRevocation(owner.address.toLowerCase(), hash); // claims owner
    const r = await postRevoke({ revocation: rev, revocation_signature: await sign(attacker, rev) });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('signature_mismatch');
  });

  it('revoke a missing policy → policy_not_found (404)', async () => {
    const owner = Wallet.createRandom();
    const rev = makeRevocation(owner.address.toLowerCase(), '0x' + 'f'.repeat(64));
    const r = await postRevoke({ revocation: rev, revocation_signature: await sign(owner, rev) });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('policy_not_found');
  });

  it('expired revocation → expired (401)', async () => {
    const owner = Wallet.createRandom();
    const { hash } = await register(owner);
    const rev = makeRevocation(owner.address.toLowerCase(), hash, { expiry: Math.floor(Date.now() / 1000) - 10 });
    const r = await postRevoke({ revocation: rev, revocation_signature: await sign(owner, rev) });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('expired');
    expect(store().signed_policies[0].revoked_at ?? null).toBeNull();
  });

  it('re-revoking an already-revoked policy → replay (409)', async () => {
    const owner = Wallet.createRandom();
    const { hash } = await register(owner);
    const rev1 = makeRevocation(owner.address.toLowerCase(), hash);
    expect((await postRevoke({ revocation: rev1, revocation_signature: await sign(owner, rev1) })).status).toBe(200);
    const rev2 = makeRevocation(owner.address.toLowerCase(), hash); // fresh nonce, same policy
    const r = await postRevoke({ revocation: rev2, revocation_signature: await sign(owner, rev2) });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('replay');
  });

  it('reusing a revocation nonce across the owner\'s policies → replay (409) via the unique guard', async () => {
    const owner = Wallet.createRandom();
    const ownerLower = owner.address.toLowerCase();
    const p1 = await register(owner, { policy_nonce: '0x' + '11'.repeat(16) });
    const p2 = await register(owner, { policy_nonce: '0x' + '22'.repeat(16) });
    const sharedNonce = freshNonce();
    const r1 = makeRevocation(ownerLower, p1.hash, { nonce: sharedNonce });
    expect((await postRevoke({ revocation: r1, revocation_signature: await sign(owner, r1) })).status).toBe(200);
    const r2 = makeRevocation(ownerLower, p2.hash, { nonce: sharedNonce }); // same nonce, different policy
    const r = await postRevoke({ revocation: r2, revocation_signature: await sign(owner, r2) });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('replay');
  });

  it('revoke lookup DB error → not_checked (503); raw error not returned', async () => {
    const owner = Wallet.createRandom();
    const { hash } = await register(owner);
    (globalThis as any).__SP_FAIL__ = { table: 'signed_policies', op: 'select', code: '08006', message: 'connection reset by peer' };
    const rev = makeRevocation(owner.address.toLowerCase(), hash);
    const r = await postRevoke({ revocation: rev, revocation_signature: await sign(owner, rev) });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('not_checked');
    expect(JSON.stringify(r.body)).not.toContain('connection reset by peer');
  });

  it('revoke update DB error → not_checked (503)', async () => {
    const owner = Wallet.createRandom();
    const { hash } = await register(owner);
    (globalThis as any).__SP_FAIL__ = { table: 'signed_policies', op: 'update', code: '08006', message: 'db down' };
    const rev = makeRevocation(owner.address.toLowerCase(), hash);
    const r = await postRevoke({ revocation: rev, revocation_signature: await sign(owner, rev) });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('not_checked');
  });

  it('a realistic revoke payload passes the SQL-keyword sanitizer', async () => {
    const owner = Wallet.createRandom();
    const { hash } = await register(owner);
    const rev = makeRevocation(owner.address.toLowerCase(), hash);
    const body = { revocation: rev, revocation_signature: await sign(owner, rev) };
    const serialized = JSON.stringify(body).toUpperCase();
    for (const kw of FORBIDDEN) expect(serialized.includes(kw)).toBe(false);
    expect((await postRevoke(body)).status).toBe(200);
  });
});

describe('GET /policies/:hash — public read', () => {
  it('returns only non-secret fields, incl. revoked status; no signature/nonce leaks', async () => {
    const owner = Wallet.createRandom();
    const { hash, policy } = await register(owner);
    const r = await getPolicy(hash);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      policy_hash: hash,
      owner: owner.address.toLowerCase(),
      cap: policy.cap,
      token: policy.token,
      payee_hashes: policy.payee_hashes,
      expiry: policy.expiry,
      revoked: false,
      created_at: expect.any(String),
    });
    // the signature and the policy_nonce are NOT exposed
    const s = JSON.stringify(r.body);
    expect(s).not.toContain(policy.policy_nonce);
    expect(r.body).not.toHaveProperty('signature');
    expect(r.body).not.toHaveProperty('policy_nonce');
    // payee HASH present, raw payee address absent
    expect(s).toContain(PAYEE_HASH);
    expect(s).not.toContain(PAYEE);
  });

  it('reflects revoked:true after revocation', async () => {
    const owner = Wallet.createRandom();
    const { hash } = await register(owner);
    const rev = makeRevocation(owner.address.toLowerCase(), hash);
    await postRevoke({ revocation: rev, revocation_signature: await sign(owner, rev) });
    const r = await getPolicy(hash);
    expect(r.status).toBe(200);
    expect(r.body.revoked).toBe(true);
  });

  it('missing policy → 404', async () => {
    const r = await getPolicy('0x' + 'a'.repeat(64));
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('policy_not_found');
  });

  it('GET DB error → not_checked (503)', async () => {
    const owner = Wallet.createRandom();
    const { hash } = await register(owner);
    (globalThis as any).__SP_FAIL__ = { table: 'signed_policies', op: 'select', message: 'db down' };
    const r = await getPolicy(hash);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('not_checked');
  });
});

describe('POST /jobs/verify — verify against the stored active policy (no inline policy)', () => {
  it('resolves the active policy and verifies a matching job → 200, one receipt', async () => {
    const owner = Wallet.createRandom();
    const ownerLower = owner.address.toLowerCase();
    seedOwnerAgent(ownerLower, 5000);
    await register(owner);
    const job = makeJob(ownerLower);
    const r = await postVerify({ job, job_signature: await sign(owner, job) });
    expect(r.status).toBe(200);
    expect(r.body.verified).toBe(true);
    expect(store().signed_job_receipts).toHaveLength(1);
  });

  it('enforces the payee allow-list EXACTLY as inline → payee_not_allowed (403)', async () => {
    const owner = Wallet.createRandom();
    const ownerLower = owner.address.toLowerCase();
    seedOwnerAgent(ownerLower, 5000);
    await register(owner);
    const job = makeJob(ownerLower, { payee_hash: hashPayee('0x' + 'c'.repeat(40)) });
    const r = await postVerify({ job, job_signature: await sign(owner, job) });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('payee_not_allowed');
  });

  it('enforces the RepID-tightened cap EXACTLY as inline → cap_exceeded (403)', async () => {
    const owner = Wallet.createRandom();
    const ownerLower = owner.address.toLowerCase();
    seedOwnerAgent(ownerLower, 50); // ceiling 50 tokens
    await register(owner, { cap: '500000000' }); // policy allows 500 tokens
    const job = makeJob(ownerLower, { cap: '300000000' }); // 300 tokens: policy ok, RepID ceiling not
    const r = await postVerify({ job, job_signature: await sign(owner, job) });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('cap_exceeded');
  });

  it('a signer who is not the policy owner cannot borrow a stored policy → signature_mismatch (401)', async () => {
    const owner = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const ownerLower = owner.address.toLowerCase();
    seedOwnerAgent(ownerLower, 5000);
    await register(owner);
    // attacker names the owner as job.owner but signs with their own key
    const job = makeJob(ownerLower);
    const r = await postVerify({ job, job_signature: await sign(attacker, job) });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('signature_mismatch');
  });

  it('no stored policy for the owner → no_active_policy (404)', async () => {
    const owner = Wallet.createRandom();
    const ownerLower = owner.address.toLowerCase();
    seedOwnerAgent(ownerLower, 5000);
    const job = makeJob(ownerLower);
    const r = await postVerify({ job, job_signature: await sign(owner, job) });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('no_active_policy');
  });

  it('an expired active policy is NOT active (instrument proven both ways)', async () => {
    const owner = Wallet.createRandom();
    const ownerLower = owner.address.toLowerCase();
    seedOwnerAgent(ownerLower, 5000);
    await register(owner); // valid, future-expiry policy, valid signature stored

    // Simulate time passing: the stored expiry column is now in the past.
    const row = store().signed_policies[0];
    const originalExpiry = row.expiry;
    row.expiry = Math.floor(Date.now() / 1000) - 10;
    const job1 = makeJob(ownerLower);
    const expired = await postVerify({ job: job1, job_signature: await sign(owner, job1) });
    expect(expired.status).toBe(404);
    expect(expired.body.error).toBe('no_active_policy');

    // Restore the future expiry (signature untouched) → the SAME setup now passes.
    row.expiry = originalExpiry;
    const job2 = makeJob(ownerLower);
    const active = await postVerify({ job: job2, job_signature: await sign(owner, job2) });
    expect(active.status).toBe(200);
    expect(active.body.verified).toBe(true);
  });

  it('active-policy lookup DB error → not_checked (503)', async () => {
    const owner = Wallet.createRandom();
    const ownerLower = owner.address.toLowerCase();
    seedOwnerAgent(ownerLower, 5000);
    await register(owner);
    (globalThis as any).__SP_FAIL__ = { table: 'signed_policies', op: 'select', message: 'db down' };
    const job = makeJob(ownerLower);
    const r = await postVerify({ job, job_signature: await sign(owner, job) });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('not_checked');
  });

  it('INLINE policy path is unchanged: an inline policy still verifies without any stored policy', async () => {
    const owner = Wallet.createRandom();
    const ownerLower = owner.address.toLowerCase();
    seedOwnerAgent(ownerLower, 5000);
    const policy = makePolicy(ownerLower);
    const job = makeJob(ownerLower);
    const r = await postVerify({
      policy,
      policy_signature: await sign(owner, policy),
      job,
      job_signature: await sign(owner, job),
    });
    expect(r.status).toBe(200);
    expect(r.body.verified).toBe(true);
    // nothing was registered; the inline path never read signed_policies
    expect(store().signed_policies).toHaveLength(0);
  });
});

describe('flag OFF and leak-safety', () => {
  it('flag OFF → 404 with NO database read, on every route', async () => {
    const owner = Wallet.createRandom();
    const policy = makePolicy(owner.address.toLowerCase());
    process.env.SIGNED_JOB_VERIFY_ENABLED = 'false';
    try {
      meta().fromCalls = 0;
      const r1 = await postPolicy({ policy, policy_signature: await sign(owner, policy) });
      const rev = makeRevocation(owner.address.toLowerCase(), '0x' + 'a'.repeat(64));
      const r2 = await postRevoke({ revocation: rev, revocation_signature: await sign(owner, rev) });
      const r3 = await getPolicy('0x' + 'a'.repeat(64));
      expect(r1.status).toBe(404);
      expect(r2.status).toBe(404);
      expect(r3.status).toBe(404);
      expect(r1.body.error).toBe('not_found');
      expect(meta().fromCalls).toBe(0);
    } finally {
      process.env.SIGNED_JOB_VERIFY_ENABLED = 'true';
    }
  });

  it('no key / secret / RAW PAYEE ADDRESS is stored or returned — only hashes', async () => {
    const owner = Wallet.createRandom();
    const rawPayee = '0x' + 'd'.repeat(40);
    const rawPayeeHash = hashPayee(rawPayee);

    const logs: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    const errSpy = jest.spyOn(console, 'error').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    let body: any;
    try {
      const { hash } = await register(owner, { payee_hashes: [rawPayeeHash] });
      const r = await getPolicy(hash);
      body = r.body;
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    // the stored row holds the policy object (hashes + cap) and a signature, and NO key/ciphertext column
    const row = store().signed_policies[0];
    expect(new Set(Object.keys(row))).toEqual(
      new Set(['id', 'policy_hash', 'owner', 'policy_json', 'signature', 'chain_id', 'expiry', 'created_at']),
    );
    const rowStr = JSON.stringify(row);
    expect(rowStr).toContain(rawPayeeHash);
    expect(rowStr).not.toContain(rawPayee);
    expect(rowStr.toLowerCase()).not.toContain('private');

    // the public read carries the hash, never the raw address
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toContain(rawPayeeHash);
    expect(bodyStr).not.toContain(rawPayee);

    // nothing sensitive escaped to a log sink
    expect(logs.join('\n')).not.toContain(rawPayee);
  });
});
