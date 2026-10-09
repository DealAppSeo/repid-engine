/**
 * GET /api/v1/receipts/:owner/:nonce — the TrustKeys reference-tier PUBLIC receipt lookup.
 *
 * These pin the honest contract of src/routes/v1/receipts.ts:
 *   - a stored receipt → 200 with EXACTLY the non-secret fields (action, cap, payee_hash, chain_id,
 *     signature_status, created_at) plus the engine attestation (receipt_signature, engine_signer,
 *     attested) and nothing else — even when the underlying row carries extra secret-shaped columns,
 *     the route's explicit projection must not leak them;
 *   - the engine attestation surfaces honestly: a row WITH a stored signature → attested:true with the
 *     signature + signer; a row WITHOUT one → attested:false with both null (never "attestation failed");
 *   - an absent receipt → 404;
 *   - flag OFF → 404 with NO database read (the gate returns before any db.from());
 *   - a DB error → not_checked (503), and the raw error text never appears in the response;
 *   - a malformed owner → a clean 400 (not a crash, not a 503);
 *   - the owner is lowercased before the lookup (a mixed-case address still resolves its receipt);
 *   - NO key / prompt / sentence / RAW PAYEE ADDRESS ever appears in the response — only the payee HASH.
 *
 * The DB is an in-memory mock, same shape as tests/signed-job-verify.test.ts. No network, no config
 * boot (src/db is mocked, so src/config is never loaded).
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
  delete (globalThis as any).__RL_STORE__;
  delete (globalThis as any).__RL_FAIL__;
  delete (globalThis as any).__RL_META__;
});

jest.mock('../src/db', () => {
  const store: Record<string, any[]> = { signed_job_receipts: [] };
  const meta = { fromCalls: 0 };
  (globalThis as any).__RL_STORE__ = store;
  (globalThis as any).__RL_META__ = meta;
  const fail = () => (globalThis as any).__RL_FAIL__ as { table?: string; message?: string; code?: string } | null;

  // A deliberately NON-projecting mock: .select() keeps the whole row. That is the point — it proves
  // the ROUTE (not the DB) is what narrows the response to the non-secret fields, even if the row
  // carries extra columns. Supports exactly the chain the route uses: select().eq().eq().maybeSingle().
  class Q {
    table: string;
    private _filters: Array<(r: any) => boolean> = [];
    constructor(table: string) { this.table = table; }
    select() { return this; }
    eq(col: string, val: any) { this._filters.push((r) => r[col] === val); return this; }
    maybeSingle() {
      const f = fail();
      if (f && (!f.table || f.table === this.table)) {
        return Promise.resolve({ data: null, error: { message: f.message ?? 'boom', code: f.code } });
      }
      const rows = (store[this.table] ||= []).filter((r) => this._filters.every((fn) => fn(r)));
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    }
  }
  const db = { from: (table: string) => { meta.fromCalls++; return new Q(table); } };
  return { db };
});

import express from 'express';
import request from 'supertest';

type Store = Record<string, any[]>;
const store = (): Store => (globalThis as any).__RL_STORE__;
const meta = (): { fromCalls: number } => (globalThis as any).__RL_META__;

let app: express.Express;

const OWNER = '0x' + 'a'.repeat(40);
const NONCE = '0x' + '00'.repeat(15) + '01';
const PAYEE_HASH = '0xee441ddf4990cb02d0fd89b94e7db060430759c5d4a9202b9f4614e678b91515';
const RAW_PAYEE = '0x' + 'b'.repeat(40); // a raw address that must NEVER appear in a response
const SECRET = 'super-secret-never-leak';
const RECEIPT_SIG = '0x' + 'c'.repeat(130); // engine attestation signature (public)
const ENGINE_SIGNER = '0x' + 'E'.repeat(40); // engine attestation signer address (public)

function reset() {
  const s = store();
  for (const k of Object.keys(s)) s[k].length = 0;
  meta().fromCalls = 0;
  (globalThis as any).__RL_FAIL__ = null;
}

/**
 * Seed a receipt whose row ALSO carries secret-shaped columns the table does not actually have.
 * If any of them leaks into the response, the projection is broken.
 */
function seedReceipt(over: Record<string, any> = {}) {
  store().signed_job_receipts.push({
    id: 'rcpt-1',
    owner: OWNER,
    nonce: NONCE,
    action: 'spend',
    cap: '1000000',
    payee_hash: PAYEE_HASH,
    chain_id: 84532,
    signature_status: 'verified',
    created_at: '2026-10-09T00:00:00.000Z',
    receipt_signature: RECEIPT_SIG, // engine attestation (public) — surfaced as attested:true
    receipt_signer: ENGINE_SIGNER,
    // secret-shaped decoys — must never be returned:
    secret_key: SECRET,
    prompt: SECRET,
    sentence: SECRET,
    raw_payee: RAW_PAYEE,
    signature: '0xdeadbeef',
    ...over,
  });
}

const get = (owner: string, nonce: string) => request(app).get(`/api/v1/receipts/${owner}/${nonce}`);

const NON_SECRET_KEYS = ['action', 'cap', 'payee_hash', 'chain_id', 'signature_status', 'created_at', 'receipt_signature', 'engine_signer', 'attested'];

beforeAll(() => {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const receiptLookupRouter = require('../src/routes/v1/receipts').default;
  /* eslint-enable @typescript-eslint/no-var-requires */
  app = express();
  app.use(express.json());
  app.use('/api/v1', receiptLookupRouter);
});
beforeEach(() => reset());

describe('GET /receipts/:owner/:nonce — the public receipt lookup', () => {
  it('stored receipt → 200 with EXACTLY the non-secret fields (incl. engine attestation) and nothing else', async () => {
    seedReceipt();
    const r = await get(OWNER, NONCE);
    expect(r.status).toBe(200);
    expect(new Set(Object.keys(r.body))).toEqual(new Set(NON_SECRET_KEYS));
    expect(r.body).toEqual({
      action: 'spend',
      cap: '1000000',
      payee_hash: PAYEE_HASH,
      chain_id: 84532,
      signature_status: 'verified',
      created_at: '2026-10-09T00:00:00.000Z',
      receipt_signature: RECEIPT_SIG,
      engine_signer: ENGINE_SIGNER,
      attested: true,
    });
  });

  it('a receipt WITH a stored engine signature → attested:true, signature + signer present', async () => {
    seedReceipt();
    const r = await get(OWNER, NONCE);
    expect(r.status).toBe(200);
    expect(r.body.attested).toBe(true);
    expect(r.body.receipt_signature).toBe(RECEIPT_SIG);
    expect(r.body.engine_signer).toBe(ENGINE_SIGNER);
  });

  it('a receipt WITHOUT a stored engine signature → attested:false, both null (never "attestation failed")', async () => {
    seedReceipt({ receipt_signature: null, receipt_signer: null }); // written unsigned (key was unset at verify time)
    const r = await get(OWNER, NONCE);
    expect(r.status).toBe(200);
    expect(r.body.attested).toBe(false);
    expect(r.body.receipt_signature).toBeNull();
    expect(r.body.engine_signer).toBeNull();
    // the receipt itself is still a verified job — the engine attestation is ADDITIONAL, not the verdict
    expect(r.body.signature_status).toBe('verified');
  });

  it('NO key / prompt / sentence / RAW PAYEE ADDRESS / signature ever appears — only the payee HASH', async () => {
    seedReceipt();
    const r = await get(OWNER, NONCE);
    expect(r.status).toBe(200);
    const serialized = JSON.stringify(r.body);
    expect(serialized).toContain(PAYEE_HASH); // the hash is present
    expect(serialized).not.toContain(RAW_PAYEE); // the raw address is not
    expect(serialized).not.toContain(SECRET); // no key / prompt / sentence decoy
    expect(serialized).not.toContain('0xdeadbeef'); // no signature
    for (const leak of ['secret_key', 'prompt', 'sentence', 'raw_payee', 'signature', 'owner', 'nonce', 'id']) {
      expect(Object.prototype.hasOwnProperty.call(r.body, leak)).toBe(false);
    }
  });

  it('owner is lowercased before the lookup (mixed-case address resolves its receipt)', async () => {
    seedReceipt(); // stored lowercased
    const mixed = '0x' + 'A'.repeat(40);
    const r = await get(mixed, NONCE);
    expect(r.status).toBe(200);
    expect(r.body.payee_hash).toBe(PAYEE_HASH);
  });

  it('absent receipt → 404', async () => {
    // store empty
    const r = await get(OWNER, NONCE);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('receipt_not_found');
  });

  it('flag OFF → 404 with NO database read', async () => {
    seedReceipt();
    process.env.SIGNED_JOB_VERIFY_ENABLED = 'false';
    try {
      const r = await get(OWNER, NONCE);
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('not_found');
      expect(meta().fromCalls).toBe(0); // the gate returns before any db.from()
    } finally {
      process.env.SIGNED_JOB_VERIFY_ENABLED = 'true';
    }
  });

  it('DB error → not_checked (503); the raw error text is NOT returned', async () => {
    seedReceipt();
    (globalThis as any).__RL_FAIL__ = { table: 'signed_job_receipts', message: 'connection reset by peer', code: '08006' };
    const r = await get(OWNER, NONCE);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe('not_checked');
    expect(JSON.stringify(r.body)).not.toContain('connection reset by peer');
  });

  it('malformed owner → clean 400 (not a crash, not a 503), and NO database read', async () => {
    const r = await get('not-an-address', NONCE);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_request');
    expect(meta().fromCalls).toBe(0); // rejected before the query
  });

  it('malformed owner (0x but wrong length) → 400', async () => {
    const r = await get('0x1234', NONCE);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('bad_request');
  });
});
