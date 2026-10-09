/**
 * receipt-attestation.test.ts — the ENGINE-signed receipt attestation, end to end.
 *
 * Turns a receipt from "our DB row" into an independently-verifiable ENGINE attestation. These pin the
 * honest contract of src/services/receipt-attestation.ts and the two public crypto routes it feeds:
 *
 *   SERVICE (pure crypto, no DB):
 *     - with RECEIPT_SIGNING_KEY set: signReceipt returns { signature, signer } and
 *       verifyReceiptAttestation recovers the SAME engine signer; engineSignerAddress is that address;
 *     - a tampered field OR a tampered signature → verified:false (never a false pass);
 *     - with the key UNSET: signReceipt → null (never throws), engineSignerAddress → null,
 *       verifyReceiptAttestation → { verified:false, engine_signer:null } (inert, not "failed").
 *
 *   WRITE PATH (POST /api/v1/jobs/verify):
 *     - key SET: a verified job stores receipt_signature + receipt_signer, and the stored signature
 *       verifies against the engine signer over the EXACT stored time;
 *     - key UNSET: the receipt is written UNSIGNED (both columns NULL) — the job is still verified;
 *     - a signing/store failure never fails the verify.
 *
 *   PUBLIC ROUTES:
 *     - GET  /receipts/signer → { engine_signer } (the address, or null when the key is unset);
 *     - POST /receipts/verify → { verified, engine_signer } for a valid receipt+signature; a tampered
 *       field/signature → verified:false; a malformed body → a clean 400 (never a crash or 503);
 *     - the lookup reports attested:true (signed) / attested:false (unsigned);
 *     - every route 404s with NO work when SIGNED_JOB_VERIFY_ENABLED is off.
 *
 *   NO LEAK: the RECEIPT_SIGNING_KEY private key never appears in any response, stored row, or log sink.
 *
 * The engine key is a THROWAWAY ethers Wallet generated in-test — never a real key. The DB is an
 * in-memory mock (same shape as tests/signed-job-verify.test.ts); no network, no config boot.
 */

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SIGNED_JOB_VERIFY_ENABLED', 'RECEIPT_SIGNING_KEY'] as const;
const ENV_SNAPSHOT: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ENV_SNAPSHOT[k] = process.env[k];
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'dummy';
process.env.SIGNED_JOB_VERIFY_ENABLED = 'true'; // default-on for the suite; flag-off tests flip it
delete process.env.RECEIPT_SIGNING_KEY; // default-UNSET; the key-set tests set it explicitly
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
import { engineSignerAddress, signReceipt, verifyReceiptAttestation, type ReceiptFields } from '../src/services/receipt-attestation';

type Store = Record<string, any[]>;
const store = (): Store => (globalThis as any).__SJ_STORE__;
const meta = (): { fromCalls: number } => (globalThis as any).__SJ_META__;

// A fixed throwaway engine attestation key (a freshly generated zero-value test key). NEVER a real key.
const ENGINE = Wallet.createRandom();
const ENGINE_KEY = ENGINE.privateKey;
const ENGINE_ADDR = ENGINE.address; // ethers returns a checksummed address

function setKey() { process.env.RECEIPT_SIGNING_KEY = ENGINE_KEY; }
function unsetKey() { delete process.env.RECEIPT_SIGNING_KEY; }

const PAYEE = '0x' + 'b'.repeat(40);
const PAYEE_HASH = hashPayee(PAYEE);
const CHAIN_ID = 84532;

function reset() {
  const s = store();
  for (const k of Object.keys(s)) s[k].length = 0;
  meta().fromCalls = 0;
  (globalThis as any).__SJ_FAIL__ = null;
}

function sampleFields(over: Partial<ReceiptFields> = {}): ReceiptFields {
  return {
    owner: '0x' + 'a'.repeat(40),
    nonce: '0x' + '00'.repeat(15) + '01',
    action: 'spend',
    cap: '1000000',
    payee_hash: PAYEE_HASH,
    chain_id: CHAIN_ID,
    time: '2026-10-09T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => { reset(); unsetKey(); process.env.SIGNED_JOB_VERIFY_ENABLED = 'true'; });

// ───────────────────────────────── service: pure crypto ─────────────────────────────────

describe('receipt-attestation service', () => {
  it('key SET: signReceipt returns { signature, signer }, and verifyReceiptAttestation recovers the engine signer', async () => {
    setKey();
    const fields = sampleFields();
    const att = await signReceipt(fields);
    expect(att).not.toBeNull();
    expect(att!.signer).toBe(ENGINE_ADDR);
    expect(engineSignerAddress()).toBe(ENGINE_ADDR);

    const v = verifyReceiptAttestation(fields, att!.signature);
    expect(v).toEqual({ verified: true, engine_signer: ENGINE_ADDR });
  });

  it('key SET: a TAMPERED field → verified:false (the signer no longer matches)', async () => {
    setKey();
    const fields = sampleFields();
    const att = await signReceipt(fields);
    const v = verifyReceiptAttestation(sampleFields({ cap: '2000000' }), att!.signature);
    expect(v.verified).toBe(false);
    expect(v.engine_signer).toBe(ENGINE_ADDR); // we still publish who we expected
  });

  it('key SET: a TAMPERED signature → verified:false (no crash)', async () => {
    setKey();
    const fields = sampleFields();
    const att = await signReceipt(fields);
    // Tamper a byte in r (first 32 bytes), NOT the trailing v/recovery byte: flipping v between
    // equivalent encodings (0x1b/27 and 0x00/0 are both yParity 0) recovers the SAME signer, so a
    // v-flip is not a real tamper. A changed r recovers a different address or fails recovery —
    // both → verified:false, deterministically, for any key.
    const sig = att!.signature;
    const flipped = '0x' + (sig.slice(2, 4) === '00' ? '11' : '00') + sig.slice(4);
    const v = verifyReceiptAttestation(fields, flipped);
    expect(v.verified).toBe(false);
  });

  it('key SET: a signature from a DIFFERENT key → verified:false', async () => {
    setKey();
    const fields = sampleFields();
    const other = Wallet.createRandom();
    const foreign = await other.signMessage(canonicalJson({ v: 1, type: 'trustkeys-receipt', ...fields }));
    const v = verifyReceiptAttestation(fields, foreign);
    expect(v.verified).toBe(false);
    expect(v.engine_signer).toBe(ENGINE_ADDR);
  });

  it('owner casing does not matter: a mixed-case owner verifies against the lowercased signature', async () => {
    setKey();
    const lower = sampleFields({ owner: '0x' + 'a'.repeat(40) });
    const att = await signReceipt(lower);
    const mixed = sampleFields({ owner: '0x' + 'A'.repeat(40) });
    expect(verifyReceiptAttestation(mixed, att!.signature).verified).toBe(true);
  });

  it('key UNSET: signReceipt → null (never throws), engineSignerAddress → null, verify → { false, null }', async () => {
    unsetKey();
    await expect(signReceipt(sampleFields())).resolves.toBeNull();
    expect(engineSignerAddress()).toBeNull();
    expect(verifyReceiptAttestation(sampleFields(), '0x' + 'cd'.repeat(65))).toEqual({ verified: false, engine_signer: null });
  });

  it('key present but MALFORMED: signReceipt → null, engineSignerAddress → null (no throw, no key in the log)', async () => {
    process.env.RECEIPT_SIGNING_KEY = 'not-a-valid-private-key';
    const logs: string[] = [];
    const errSpy = jest.spyOn(console, 'error').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    try {
      await expect(signReceipt(sampleFields())).resolves.toBeNull();
      expect(engineSignerAddress()).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
    expect(logs.join('\n')).not.toContain('not-a-valid-private-key');
  });

  it('the private key never appears in a return value', async () => {
    setKey();
    const att = await signReceipt(sampleFields());
    expect(JSON.stringify(att)).not.toContain(ENGINE_KEY);
    expect(engineSignerAddress()).not.toContain(ENGINE_KEY);
  });
});

// ───────────────────────────────── write path: POST /jobs/verify ─────────────────────────────────

describe('write path — POST /api/v1/jobs/verify stores the engine attestation', () => {
  let app: express.Express;
  beforeAll(() => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const jobsRouter = require('../src/routes/v1/jobs').default;
    /* eslint-enable @typescript-eslint/no-var-requires */
    app = express();
    app.use(express.json());
    app.use('/api/v1', jobsRouter);
  });

  function seedOwnerAgent(ownerLower: string, repid: number) {
    store().human_agent_bindings.push({ id: 'bind-1', agent_id: 'agent-x', human_wallet: ownerLower, scope: 'ownership', revoked_at: null });
    store().repid_agents.push({ id: 'agent-x', agent_name: 'Owned Agent', current_repid: repid });
  }
  let nonceSeq = 0;
  const freshNonce = () => '0x' + (++nonceSeq).toString(16).padStart(32, '0');
  async function buildBody(owner: Wallet, nonce: string) {
    const ownerLower = owner.address.toLowerCase();
    const policy = {
      v: 1, type: 'trustkeys-policy', owner: ownerLower, chain_id: CHAIN_ID, cap: '1000000000',
      token: 'USDC', payee_hashes: [PAYEE_HASH], expiry: Math.floor(Date.now() / 1000) + 3600, policy_nonce: '0x' + 'ab'.repeat(16),
    };
    const job = {
      v: 1, type: 'trustkeys-job', owner: ownerLower, chain_id: CHAIN_ID, action: 'spend', cap: '1000000',
      payee_hash: PAYEE_HASH, expiry: Math.floor(Date.now() / 1000) + 3600, nonce,
    };
    return { policy, policy_signature: await owner.signMessage(canonicalJson(policy)), job, job_signature: await owner.signMessage(canonicalJson(job)) };
  }
  const post = (body: unknown) => request(app).post('/api/v1/jobs/verify').send(body as any);

  it('key SET → a verified job stores receipt_signature + receipt_signer, and the stored signature verifies', async () => {
    setKey();
    const owner = Wallet.createRandom();
    const ownerLower = owner.address.toLowerCase();
    seedOwnerAgent(ownerLower, 5000);
    const nonce = freshNonce();
    const r = await post(await buildBody(owner, nonce));
    expect(r.status).toBe(200);
    expect(r.body.verified).toBe(true);
    // the verify RESPONSE is unchanged — the attestation is on the row, not here
    expect(r.body.receipt.receipt_signature).toBeUndefined();

    const row = store().signed_job_receipts[0];
    expect(row.receipt_signer).toBe(ENGINE_ADDR);
    expect(typeof row.receipt_signature).toBe('string');

    // the stored signature verifies against the engine signer over the EXACT stored fields
    const fields: ReceiptFields = { owner: row.owner, nonce: row.nonce, action: row.action, cap: row.cap, payee_hash: row.payee_hash, chain_id: row.chain_id, time: row.created_at };
    expect(verifyReceiptAttestation(fields, row.receipt_signature)).toEqual({ verified: true, engine_signer: ENGINE_ADDR });
  });

  it('key UNSET → the receipt is written UNSIGNED (both columns absent/NULL); the job is still verified', async () => {
    unsetKey();
    const owner = Wallet.createRandom();
    seedOwnerAgent(owner.address.toLowerCase(), 5000);
    const r = await post(await buildBody(owner, freshNonce()));
    expect(r.status).toBe(200);
    expect(r.body.verified).toBe(true);
    const row = store().signed_job_receipts[0];
    expect(row.receipt_signature ?? null).toBeNull();
    expect(row.receipt_signer ?? null).toBeNull();
    expect(row.signature_status).toBe('verified');
  });

  it('key SET but the attestation STORE fails → the verify still succeeds (attestation is additive)', async () => {
    setKey();
    const owner = Wallet.createRandom();
    seedOwnerAgent(owner.address.toLowerCase(), 5000);
    // Fail only the UPDATE leg (the attestation store), not the insert.
    (globalThis as any).__SJ_FAIL__ = { table: 'signed_job_receipts', op: 'update', code: '08006', message: 'connection reset' };
    const logs: string[] = [];
    const errSpy = jest.spyOn(console, 'error').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    let r: any;
    try {
      r = await post(await buildBody(owner, freshNonce()));
    } finally {
      errSpy.mockRestore();
    }
    expect(r.status).toBe(200);
    expect(r.body.verified).toBe(true); // a verified job stays verified even if we could not record our attestation
    expect(store().signed_job_receipts).toHaveLength(1);
    expect(logs.join('\n')).not.toContain(ENGINE_KEY); // the key never leaks to a log sink
  });

  it('no key material leaks to a log sink on the happy path', async () => {
    setKey();
    const owner = Wallet.createRandom();
    seedOwnerAgent(owner.address.toLowerCase(), 5000);
    const logs: string[] = [];
    const logSpy = jest.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    const errSpy = jest.spyOn(console, 'error').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    try {
      await post(await buildBody(owner, freshNonce()));
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(logs.join('\n')).not.toContain(ENGINE_KEY);
  });
});

// ───────────────────────────────── public routes: signer + verify + lookup ─────────────────────────────────

describe('public routes — GET /receipts/signer, POST /receipts/verify, GET /receipts/:owner/:nonce', () => {
  let app: express.Express;
  beforeAll(() => {
    /* eslint-disable @typescript-eslint/no-var-requires */
    const receiptLookupRouter = require('../src/routes/v1/receipts').default;
    /* eslint-enable @typescript-eslint/no-var-requires */
    app = express();
    app.use(express.json());
    app.use('/api/v1', receiptLookupRouter);
  });

  const getSigner = () => request(app).get('/api/v1/receipts/signer');
  const postVerify = (body: unknown) => request(app).post('/api/v1/receipts/verify').send(body as any);
  const getReceipt = (owner: string, nonce: string) => request(app).get(`/api/v1/receipts/${owner}/${nonce}`);

  it('GET /receipts/signer → the engine signer address when the key is SET', async () => {
    setKey();
    const r = await getSigner();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ engine_signer: ENGINE_ADDR });
  });

  it('GET /receipts/signer → { engine_signer: null } when the key is UNSET', async () => {
    unsetKey();
    const r = await getSigner();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ engine_signer: null });
  });

  it('GET /receipts/signer → 404 with NO work when the flag is OFF', async () => {
    setKey();
    process.env.SIGNED_JOB_VERIFY_ENABLED = 'false';
    const r = await getSigner();
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('POST /receipts/verify → verified:true for a valid receipt + its engine signature', async () => {
    setKey();
    const fields = sampleFields();
    const att = await signReceipt(fields);
    const r = await postVerify({ receipt: fields, receipt_signature: att!.signature });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ verified: true, engine_signer: ENGINE_ADDR });
  });

  it('POST /receipts/verify → verified:false for a tampered field, no DB read', async () => {
    setKey();
    const fields = sampleFields();
    const att = await signReceipt(fields);
    const r = await postVerify({ receipt: { ...fields, cap: '9999' }, receipt_signature: att!.signature });
    expect(r.status).toBe(200);
    expect(r.body.verified).toBe(false);
    expect(r.body.engine_signer).toBe(ENGINE_ADDR);
    expect(meta().fromCalls).toBe(0); // pure crypto: no database touched
  });

  it('POST /receipts/verify → verified:false when the engine key is UNSET (engine_signer null)', async () => {
    unsetKey();
    const fields = sampleFields();
    const r = await postVerify({ receipt: fields, receipt_signature: '0x' + 'cd'.repeat(65) });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ verified: false, engine_signer: null });
  });

  it('POST /receipts/verify → a malformed body is a clean 400 (never a crash or a 503)', async () => {
    setKey();
    const good = sampleFields();
    const goodSig = '0x' + 'cd'.repeat(65);
    const cases: any[] = [
      {},                                                                   // no receipt
      { receipt: 'nope', receipt_signature: goodSig },                      // receipt not an object
      { receipt: good },                                                    // missing signature
      { receipt: good, receipt_signature: 'not-hex' },                      // bad signature shape
      { receipt: { ...good, owner: 'nope' }, receipt_signature: goodSig },  // bad owner
      { receipt: { ...good, cap: 'x' }, receipt_signature: goodSig },       // bad cap
      { receipt: { ...good, chain_id: '84532' }, receipt_signature: goodSig }, // chain_id not a number
      { receipt: { ...good, time: '' }, receipt_signature: goodSig },       // empty time
    ];
    for (const body of cases) {
      const r = await postVerify(body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('bad_request');
    }
  });

  it('POST /receipts/verify → 404 with NO work when the flag is OFF', async () => {
    setKey();
    process.env.SIGNED_JOB_VERIFY_ENABLED = 'false';
    const r = await postVerify({ receipt: sampleFields(), receipt_signature: '0x' + 'cd'.repeat(65) });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('end to end: a signed row reads back attested:true and its signature verifies via POST /receipts/verify', async () => {
    setKey();
    const owner = '0x' + 'a'.repeat(40);
    const nonce = '0x' + '00'.repeat(15) + '09';
    const created = '2026-10-09T12:00:00.000Z';
    const fields = sampleFields({ owner, nonce, time: created });
    const att = await signReceipt(fields);
    // seed the stored row exactly as the write path would have
    store().signed_job_receipts.push({
      id: 'rcpt-e2e', owner, nonce, action: fields.action, cap: fields.cap, payee_hash: fields.payee_hash,
      chain_id: fields.chain_id, signature_status: 'verified', created_at: created,
      receipt_signature: att!.signature, receipt_signer: att!.signer,
    });

    const look = await getReceipt(owner, nonce);
    expect(look.status).toBe(200);
    expect(look.body.attested).toBe(true);
    expect(look.body.engine_signer).toBe(ENGINE_ADDR);
    expect(look.body.receipt_signature).toBe(att!.signature);

    // a verifier reconstructs the fields from the lookup (+ the owner/nonce it queried) and confirms it
    const reconstructed: ReceiptFields = {
      owner, nonce, action: look.body.action, cap: look.body.cap, payee_hash: look.body.payee_hash,
      chain_id: look.body.chain_id, time: look.body.created_at,
    };
    const v = await postVerify({ receipt: reconstructed, receipt_signature: look.body.receipt_signature });
    expect(v.body).toEqual({ verified: true, engine_signer: ENGINE_ADDR });
  });

  it('a row written UNSIGNED reads back attested:false with both null', async () => {
    setKey(); // key set NOW, but the row was written when it was unset → columns NULL
    const owner = '0x' + 'a'.repeat(40);
    const nonce = '0x' + '00'.repeat(15) + '0a';
    store().signed_job_receipts.push({
      id: 'rcpt-unsigned', owner, nonce, action: 'spend', cap: '1000000', payee_hash: PAYEE_HASH,
      chain_id: CHAIN_ID, signature_status: 'verified', created_at: '2026-10-09T00:00:00.000Z',
      receipt_signature: null, receipt_signer: null,
    });
    const look = await getReceipt(owner, nonce);
    expect(look.status).toBe(200);
    expect(look.body.attested).toBe(false);
    expect(look.body.receipt_signature).toBeNull();
    expect(look.body.engine_signer).toBeNull();
  });

  it('no response from any route contains the private key', async () => {
    setKey();
    const fields = sampleFields();
    const att = await signReceipt(fields);
    const signer = await getSigner();
    const verify = await postVerify({ receipt: fields, receipt_signature: att!.signature });
    expect(JSON.stringify(signer.body)).not.toContain(ENGINE_KEY);
    expect(JSON.stringify(verify.body)).not.toContain(ENGINE_KEY);
  });
});
