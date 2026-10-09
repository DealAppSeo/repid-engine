/**
 * POST /api/v1/jobs/verify — the TrustKeys reference-tier signed-job verifier.
 *
 * "No key on our disk": the owner signs a policy once and a job per action on their own box; the
 * server verifies both signatures, that the job is inside the policy, and that RepID has not been
 * exceeded — then records ONLY receipt fields. These tests pin the honest contract:
 *   - a valid owner-signed job verifies and writes exactly one receipt;
 *   - every refuse path is a clean explicit deny (signature_mismatch, expired, payee_not_allowed,
 *     cap_exceeded, replay), and a DB/RepID error REFUSES as not_checked (503), never a pass;
 *   - RepID may only TIGHTEN — a low RepID ceiling blocks a job the policy alone would allow;
 *   - flag OFF → 404 with NO database read;
 *   - NO key / prompt / sentence / RAW PAYEE ADDRESS ever appears in the receipt, the response, or a
 *     log sink — only the payee HASH;
 *   - a realistic payload passes the global SQL-keyword body sanitizer.
 *
 * Real signatures are produced with ethers Wallet (EOA), which the jest offline-signature-chain
 * setup verifies with no network. The DB is an in-memory mock, same shape as
 * tests/human-bind-preflight.test.ts.
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
  delete (globalThis as any).__SJ_STORE__;
  delete (globalThis as any).__SJ_FAIL__;
});

jest.mock('../src/db', () => {
  const store: Record<string, any[]> = { human_agent_bindings: [], repid_agents: [], signed_job_receipts: [] };
  const meta = { fromCalls: 0 };
  (globalThis as any).__SJ_META__ = meta;
  const tbl = (name: string): any[] => (store[name] ||= []);
  const fail = () => (globalThis as any).__SJ_FAIL__ as { table?: string; op?: string; code?: string; message?: string } | null;

  class Q {
    table: string;
    private _filters: Array<(r: any) => boolean> = [];
    private _op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    private _payload: any = null;
    private _inserted: any = null;
    private _single = false;
    private _maybe = false;
    private _selected = false;
    constructor(table: string) { this.table = table; }
    select() { this._selected = true; return this; }
    eq(col: string, val: any) { this._filters.push((r) => r[col] === val); return this; }
    ilike(col: string, val: any) { const v = String(val).toLowerCase(); this._filters.push((r) => String(r[col] ?? '').toLowerCase() === v); return this; }
    in(col: string, vals: any[]) { this._filters.push((r) => vals.includes(r[col])); return this; }
    is(col: string, val: any) { this._filters.push((r) => (r[col] ?? null) === val); return this; }
    limit() { return this; } order() { return this; } range() { return this; } not() { return this; }
    gte() { return this; } lte() { return this; } gt() { return this; } lt() { return this; }
    maybeSingle() { this._maybe = true; return this; }
    single() { this._single = true; return this; }
    insert(payload: any) {
      this._op = 'insert';
      this._payload = payload;
      return this;
    }
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
        // Enforce UNIQUE(owner, nonce) on signed_job_receipts — the replay guard.
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
      if (this._op === 'update') { rows.forEach((r) => Object.assign(r, this._payload)); return { data: rows, error: null }; }
      if (this._op === 'delete') { for (const r of rows) { const i = t.indexOf(r); if (i >= 0) t.splice(i, 1); } return { data: null, error: null }; }
      if (this._single) return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows', code: 'PGRST116' } };
      if (this._maybe) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null, count: rows.length };
    }
    then(onF?: (v: any) => any, onR?: (e: any) => any) { return Promise.resolve(this._exec()).then(onF, onR); }
    catch(onR: (e: any) => any) { return this.then(undefined, onR); }
    finally(fn: () => void) { return this.then().finally(fn); }
  }
  const db = { from: (table: string) => { meta.fromCalls++; return new Q(table); } };
  (globalThis as any).__SJ_STORE__ = store;
  return { db };
});

import express from 'express';
import request from 'supertest';
import { Wallet } from 'ethers';
import { canonicalJson, hashPayee } from '../src/services/signed-job';

type Store = Record<string, any[]>;
const store = (): Store => (globalThis as any).__SJ_STORE__;
const meta = (): { fromCalls: number } => (globalThis as any).__SJ_META__;

// The production SQL-keyword body sanitizer (src/index.ts), mirrored so the suite proves a realistic
// signed-job payload survives it. A drift here would show up as a surprise 400 on the valid flow.
const FORBIDDEN = ['SELECT ', 'DROP ', 'INSERT ', 'UPDATE ', 'DELETE ', '--', ';'];
function sqlKeywordSanitizer(req: any, res: any, next: any) {
  if (req.method !== 'POST') return next();
  const scan = (obj: any): boolean => {
    for (const key in obj) {
      const val = obj[key];
      if (typeof val === 'string') {
        const up = val.toUpperCase();
        if (FORBIDDEN.some((kw) => up.includes(kw))) return false;
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
  (globalThis as any).__SJ_FAIL__ = null;
}

/** Seed a proven ownership binding (owner wallet → agent) and that agent's RepID. */
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
const sign = (w: Wallet, obj: unknown) => w.signMessage(canonicalJson(obj));

async function buildBody(owner: Wallet, policyOver = {}, jobOver = {}, signers: { policy?: Wallet; job?: Wallet } = {}) {
  const ownerLower = owner.address.toLowerCase();
  const policy = makePolicy(ownerLower, policyOver);
  const job = makeJob(ownerLower, jobOver);
  return {
    policy,
    policy_signature: await sign(signers.policy ?? owner, policy),
    job,
    job_signature: await sign(signers.job ?? owner, job),
  };
}

const post = (body: unknown) => request(app).post('/api/v1/jobs/verify').send(body as any);

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const jobsRouter = require('../src/routes/v1/jobs').default;
  /* eslint-enable @typescript-eslint/no-var-requires */
  app = express();
  app.use(express.json());
  app.use(sqlKeywordSanitizer); // prove the realistic payload passes it
  app.use('/api/v1', jobsRouter);
});
beforeEach(() => reset());

describe('POST /jobs/verify — the signed-job verifier', () => {
  it('valid owner-signed job → verified, exactly one receipt written, response carries only receipt fields', async () => {
    const owner = Wallet.createRandom();
    seedOwnerAgent(owner.address.toLowerCase(), 5000); // comfortable ceiling
    const body = await buildBody(owner);
    const r = await post(body);

    expect(r.status).toBe(200);
    expect(r.body.verified).toBe(true);
    expect(r.body.receipt).toEqual({
      action: 'spend',
      cap: '1000000',
      payee_hash: PAYEE_HASH,
      chain_id: CHAIN_ID,
      time: expect.any(String),
      signature_status: 'verified',
    });
    expect(store().signed_job_receipts).toHaveLength(1);
    const row = store().signed_job_receipts[0];
    expect(row.owner).toBe(owner.address.toLowerCase());
    expect(row.payee_hash).toBe(PAYEE_HASH);
  });

  it('a realistic valid payload passes the SQL-keyword body sanitizer (no forbidden substrings)', async () => {
    const owner = Wallet.createRandom();
    const body = await buildBody(owner);
    const serialized = JSON.stringify(body).toUpperCase();
    for (const kw of FORBIDDEN) expect(serialized.includes(kw)).toBe(false);
    // and end-to-end: the sanitizer middleware does not 400 it
    seedOwnerAgent(owner.address.toLowerCase(), 5000);
    const r = await post(body);
    expect(r.status).toBe(200);
  });

  it('wrong signer → signature_mismatch (401)', async () => {
    const owner = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    seedOwnerAgent(owner.address.toLowerCase(), 5000);
    const body = await buildBody(owner, {}, {}, { job: attacker }); // job.owner stays owner, signed by attacker
    const r = await post(body);
    expect(r.status).toBe(401);
    expect(r.body.verified).toBe(false);
    expect(r.body.error).toBe('signature_mismatch');
    expect(store().signed_job_receipts).toHaveLength(0);
  });

  it('policy and job signed by different owners → signature_mismatch (401)', async () => {
    const a = Wallet.createRandom();
    const b = Wallet.createRandom();
    const policy = makePolicy(a.address.toLowerCase());
    const job = makeJob(b.address.toLowerCase());
    const r = await post({
      policy,
      policy_signature: await sign(a, policy),
      job,
      job_signature: await sign(b, job),
    });
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('signature_mismatch');
  });

  it('expired policy or job → expired (401)', async () => {
    const owner = Wallet.createRandom();
    seedOwnerAgent(owner.address.toLowerCase(), 5000);
    const past = Math.floor(Date.now() / 1000) - 10;
    const body = await buildBody(owner, {}, { expiry: past });
    const r = await post(body);
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('expired');
    expect(store().signed_job_receipts).toHaveLength(0);
  });

  it('payee not in signed policy → payee_not_allowed (403)', async () => {
    const owner = Wallet.createRandom();
    seedOwnerAgent(owner.address.toLowerCase(), 5000);
    const otherHash = hashPayee('0x' + 'c'.repeat(40));
    const body = await buildBody(owner, {}, { payee_hash: otherHash });
    const r = await post(body);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('payee_not_allowed');
    expect(store().signed_job_receipts).toHaveLength(0);
  });

  it('job cap above the policy cap → cap_exceeded (403)', async () => {
    const owner = Wallet.createRandom();
    seedOwnerAgent(owner.address.toLowerCase(), 10000); // ceiling far above the policy cap
    const body = await buildBody(owner, { cap: '1000000' }, { cap: '2000000' }); // job > policy
    const r = await post(body);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('cap_exceeded');
  });

  it('RepID TIGHTENS: a low RepID ceiling blocks a job the policy alone would allow', async () => {
    const owner = Wallet.createRandom();
    const ownerLower = owner.address.toLowerCase();
    // policy allows up to 500 tokens; job asks for 300 tokens — the POLICY alone permits this.
    // RepID 50 → ceiling 50 tokens, so effective_cap = min(500, 50) = 50 tokens → blocked.
    seedOwnerAgent(ownerLower, 50);
    const blocked = await buildBody(owner, { cap: '500000000' }, { cap: '300000000' });
    const r1 = await post(blocked);
    expect(r1.status).toBe(403);
    expect(r1.body.error).toBe('cap_exceeded');
    expect(store().signed_job_receipts).toHaveLength(0);

    // Same policy + job shape, but a HIGH RepID → ceiling rises and the identical job now passes.
    // (Fresh nonce; only the owner's RepID changed, proving RepID is the deciding factor.)
    store().repid_agents[0].current_repid = 10000; // ceiling 10,000 tokens
    const allowed = await buildBody(owner, { cap: '500000000' }, { cap: '300000000' });
    const r2 = await post(allowed);
    expect(r2.status).toBe(200);
    expect(r2.body.verified).toBe(true);
  });

  it('duplicate (owner, nonce) → replay (409)', async () => {
    const owner = Wallet.createRandom();
    seedOwnerAgent(owner.address.toLowerCase(), 5000);
    const nonce = freshNonce();
    const first = await buildBody(owner, {}, { nonce });
    const r1 = await post(first);
    expect(r1.status).toBe(200);
    // Replay the SAME owner+nonce job (re-sign the identical object).
    const second = await buildBody(owner, {}, { nonce });
    const r2 = await post(second);
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe('replay');
    expect(store().signed_job_receipts).toHaveLength(1); // no second row written
  });

  it('RepID read errors → not_checked (503), never a pass; no receipt written', async () => {
    const owner = Wallet.createRandom();
    seedOwnerAgent(owner.address.toLowerCase(), 5000);
    (globalThis as any).__SJ_FAIL__ = { table: 'human_agent_bindings', op: 'select' };
    const body = await buildBody(owner);
    const r = await post(body);
    expect(r.status).toBe(503);
    expect(r.body.verified).toBe(false);
    expect(r.body.error).toBe('not_checked');
    expect(store().signed_job_receipts).toHaveLength(0);
  });

  it('receipt write errors (non-duplicate) → not_checked (503); raw error is NOT returned', async () => {
    const owner = Wallet.createRandom();
    seedOwnerAgent(owner.address.toLowerCase(), 5000);
    (globalThis as any).__SJ_FAIL__ = { table: 'signed_job_receipts', op: 'insert', code: '08006', message: 'connection reset by peer' };
    const body = await buildBody(owner);
    const r = await post(body);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('not_checked');
    // the raw DB error text never leaves the server
    expect(JSON.stringify(r.body)).not.toContain('connection reset by peer');
  });

  it('flag OFF → 404 with NO database read', async () => {
    const owner = Wallet.createRandom();
    const body = await buildBody(owner);
    process.env.SIGNED_JOB_VERIFY_ENABLED = 'false';
    try {
      const r = await post(body);
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('not_found');
      expect(meta().fromCalls).toBe(0); // the gate returns before any db.from()
    } finally {
      process.env.SIGNED_JOB_VERIFY_ENABLED = 'true';
    }
  });

  it('NO key / prompt / sentence / RAW PAYEE ADDRESS leaks — only the payee HASH, in receipt, response, or logs', async () => {
    const owner = Wallet.createRandom();
    const rawPayee = '0x' + 'd'.repeat(40);
    const rawPayeeHash = hashPayee(rawPayee);
    seedOwnerAgent(owner.address.toLowerCase(), 5000);
    const body = await buildBody(owner, { payee_hashes: [rawPayeeHash] }, { payee_hash: rawPayeeHash });

    const logs: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    const errSpy = jest.spyOn(console, 'error').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    let r: any;
    try {
      r = await post(body);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }

    expect(r.status).toBe(200);
    // the payee HASH is present; the RAW address is not, anywhere observable
    expect(JSON.stringify(r.body)).toContain(rawPayeeHash);
    expect(JSON.stringify(r.body)).not.toContain(rawPayee);

    const row = store().signed_job_receipts[0];
    // stored keys are exactly the receipt fields — no key/ciphertext/prompt/sentence/raw-address column
    expect(new Set(Object.keys(row))).toEqual(new Set(['id', 'owner', 'nonce', 'action', 'cap', 'payee_hash', 'chain_id', 'signature_status', 'created_at']));
    const rowStr = JSON.stringify(row);
    expect(rowStr).toContain(rawPayeeHash);
    expect(rowStr).not.toContain(rawPayee);

    // nothing sensitive escaped to a log sink
    const allLogs = logs.join('\n');
    expect(allLogs).not.toContain(rawPayee);
    expect(allLogs).not.toContain(body.policy_signature);
    expect(allLogs).not.toContain(body.job_signature);
  });
});
