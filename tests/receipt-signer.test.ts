/**
 * receipt-signer.test.ts — the SERVICE-KEY receipt signer (Lane 2), end to end.
 *
 * Pins the honest contract of src/services/receipt-signer.ts and its fail-closed wire-in at the
 * receipt-WRITE path (src/services/receipt-issuer.ts → issueReceipt):
 *
 *   SERVICE (pure crypto, no DB):
 *     - key SET: signReceipt → { ok:true, signature }, verifyReceiptSignature recovers the SAME engine
 *       signer (VERIFIED); a tampered RECEIPT or a tampered SIGNATURE → FAILED (never a false pass);
 *     - key UNSET / MALFORMED: signReceipt → { ok:false, reason:'no_signing_key' } (FAIL CLOSED, never
 *       a forged signed receipt); verifyReceiptSignature → NOT_CHECKED (never a pass).
 *
 *   SEPARATION (a receipt-only key, never a payment key):
 *     - the signer reads ONLY RECEIPT_SIGNING_KEY — not any `<AGENT>_PRIVATE_KEY`, AGENT_KEY_MASTER,
 *       DEPLOYER_PRIVATE_KEY, or ERC8004_* — proven at runtime AND by a source scan;
 *     - a receipt signature can NEVER be a valid x402/EIP-712 payment authorization (EIP-191 vs EIP-712).
 *
 *   WRITE PATH (issueReceipt, DB mocked):
 *     - flag OFF: the issued receipt is byte-for-byte unchanged (no signature field), one row written;
 *     - flag ON + key SET: the receipt carries a verifiable `engine_signature`, persisted on the row;
 *     - flag ON + key UNSET/MALFORMED: issueReceipt THROWS and NO row is written (fail closed).
 *
 *   NO LEAK: the RECEIPT_SIGNING_KEY private key never appears in any return, stored row, or log sink.
 *
 * The engine key is a THROWAWAY ethers Wallet generated in-test — never a real key. The DB is an
 * in-memory mock; no network, no config boot, no on-chain call.
 */

const ENV_KEYS = ['SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'RECEIPT_SIGNING_KEY', 'RECEIPT_SIGNING_ENABLED'] as const;
const ENV_SNAPSHOT: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ENV_SNAPSHOT[k] = process.env[k];
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'dummy';
delete process.env.RECEIPT_SIGNING_KEY;
delete process.env.RECEIPT_SIGNING_ENABLED;
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (ENV_SNAPSHOT[k] === undefined) delete process.env[k];
    else process.env[k] = ENV_SNAPSHOT[k];
  }
  delete (globalThis as any).__RS_STORE__;
  delete (globalThis as any).__RS_FAIL__;
});

// Minimal capturing DB mock for the issueReceipt write path (insert + update().eq()).
jest.mock('../src/db', () => {
  const store: Record<string, any[]> = { hyperdag_receipts: [] };
  (globalThis as any).__RS_STORE__ = store;
  const fail = () => (globalThis as any).__RS_FAIL__ as { table?: string; op?: string; code?: string; message?: string } | null;
  class Q {
    table: string;
    private _op: 'select' | 'insert' | 'update' = 'select';
    private _payload: any = null;
    private _filters: Array<(r: any) => boolean> = [];
    private _maybe = false;
    constructor(table: string) { this.table = table; }
    select() { return this; }
    eq(col: string, val: any) { this._filters.push((r) => r[col] === val); return this; }
    maybeSingle() { this._maybe = true; return this; }
    insert(payload: any) { this._op = 'insert'; this._payload = payload; return this; }
    update(payload: any) { this._op = 'update'; this._payload = payload; return this; }
    private _exec(): { data: any; error: any } {
      const f = fail();
      if (f && f.table === this.table && (!f.op || f.op === this._op)) {
        return { data: null, error: { message: f.message ?? 'boom', code: f.code } };
      }
      const t = store[this.table] || (store[this.table] = []);
      if (this._op === 'insert') { t.push({ ...this._payload }); return { data: null, error: null }; }
      const rows = t.filter((r) => this._filters.every((fn) => fn(r)));
      if (this._op === 'update') { rows.forEach((r) => Object.assign(r, this._payload)); return { data: rows, error: null }; }
      if (this._maybe) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }
    then(onF?: (v: any) => any, onR?: (e: any) => any) { return Promise.resolve(this._exec()).then(onF, onR); }
    catch(onR: (e: any) => any) { return this.then(undefined, onR); }
    finally(fn: () => void) { return this.then().finally(fn); }
  }
  return { db: { from: (table: string) => new Q(table) } };
});

import * as fs from 'fs';
import * as path from 'path';
import { Wallet, getAddress, verifyMessage, verifyTypedData } from 'ethers';
import {
  signReceipt,
  verifyReceiptSignature,
  receiptSignerAddress,
  receiptSigningEnabled,
  canonicalize as signerCanonicalize,
  receiptContentHash,
  RECEIPT_SIGNATURE_FIELD,
  RECEIPT_SIGNATURE_TYPE,
  ReceiptSigningRequiredError,
  type ReceiptSignature,
} from '../src/services/receipt-signer';
import { issueReceipt, canonicalize as issuerCanonicalize } from '../src/services/receipt-issuer';
import type { HALOutputForReceipt } from '../src/services/receipt-issuer';

const ENGINE = Wallet.createRandom();
const ENGINE_KEY = ENGINE.privateKey;
const ENGINE_ADDR = ENGINE.address; // checksummed

const store = (): Record<string, any[]> => (globalThis as any).__RS_STORE__;
function setKey() { process.env.RECEIPT_SIGNING_KEY = ENGINE_KEY; }
function unsetKey() { delete process.env.RECEIPT_SIGNING_KEY; }
function enableFlag() { process.env.RECEIPT_SIGNING_ENABLED = 'true'; }
function disableFlag() { delete process.env.RECEIPT_SIGNING_ENABLED; }

function sampleReceipt(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'hyperdag.repid.receipt.v1',
    receiptId: '0x' + 'ab'.repeat(32),
    agent: { standard: 'ERC-8004', agentId: '42', agentWallet: '0x' + '1'.repeat(40) },
    payment: { standard: 'x402', amount: '1000000', currency: 'USDC' },
    work: { taskHash: '0x' + 'cd'.repeat(32), resultHash: '0x' + 'ef'.repeat(32) },
    timestamps: { createdAt: '2026-10-12T00:00:00.000Z' },
    ...over,
  };
}

function sampleIssueInput(over: Record<string, unknown> = {}) {
  const halOutput: HALOutputForReceipt = {
    signals: {
      harm_probability: 0.1, epistemic_uncertainty: 0.2, evidence_quality: 0.7,
      scope_appropriateness: 0.8, certainty_at_claim: 0.85, agreement_score: 0.9,
      prompt_category: 'factual', comma_veto: false, comma_gap: 0.001, comma_severity: 'none',
    } as any,
    hal_score: 0.213, vetoed: false, veto_reason: null, veto_threshold: 0.43,
    comma_veto: false, comma_gap: 0.001, comma_severity: 'none', formula: '6-DOF',
  };
  return {
    agentId: 42,
    agentWallet: '0x1234567890123456789012345678901234567890',
    x402PaymentProof: { network: 'base-sepolia', currency: 'USDC', amount: '1000000', resourceUri: 'https://example.test/r/1' },
    taskInput: { prompt: 'analyze CRE deal' },
    taskResult: { answer: 'class B office' },
    halOutput,
    repIdCommitment: ('0x' + 'aa'.repeat(32)) as `0x${string}`,
    scoreVersion: 6,
    ...over,
  };
}

beforeEach(() => {
  for (const arr of Object.values(store())) arr.length = 0;
  (globalThis as any).__RS_FAIL__ = null;
  unsetKey();
  disableFlag();
});

// ───────────────────────────── service: pure crypto ─────────────────────────────

describe('receipt-signer service — sign / verify', () => {
  it('key SET: signReceipt → {ok,signature}; verifyReceiptSignature recovers the engine signer (VERIFIED)', async () => {
    setKey();
    const receipt = sampleReceipt();
    const res = await signReceipt(receipt);
    expect(res.ok).toBe(true);
    const sig = (res as { ok: true; signature: ReceiptSignature }).signature;
    expect(sig.signer).toBe(ENGINE_ADDR);
    expect(sig.type).toBe(RECEIPT_SIGNATURE_TYPE);
    expect(sig.scheme).toBe('eip191-personal-sign');
    expect(receiptSignerAddress()).toBe(ENGINE_ADDR);

    expect(verifyReceiptSignature(receipt, sig)).toEqual({ status: 'VERIFIED', signer: ENGINE_ADDR });
    // and it reads the signature off the attached field too
    const attached = { ...receipt, [RECEIPT_SIGNATURE_FIELD]: sig };
    expect(verifyReceiptSignature(attached)).toEqual({ status: 'VERIFIED', signer: ENGINE_ADDR });
  });

  it('key SET: a TAMPERED receipt → FAILED (content hash no longer matches)', async () => {
    setKey();
    const receipt = sampleReceipt();
    const sig = (await signReceipt(receipt) as any).signature as ReceiptSignature;
    const tampered = sampleReceipt({ payment: { standard: 'x402', amount: '9999999', currency: 'USDC' } });
    const v = verifyReceiptSignature(tampered, sig);
    expect(v.status).toBe('FAILED');
    expect((v as any).signer).toBe(ENGINE_ADDR);
  });

  it('key SET: a TAMPERED signature → FAILED (no crash)', async () => {
    setKey();
    const receipt = sampleReceipt();
    const sig = (await signReceipt(receipt) as any).signature as ReceiptSignature;
    // flip a byte in r (first 32 bytes), not the trailing v byte
    const flipped = '0x' + (sig.signature.slice(2, 4) === '00' ? '11' : '00') + sig.signature.slice(4);
    const v = verifyReceiptSignature(receipt, { ...sig, signature: flipped });
    expect(v.status).toBe('FAILED');
  });

  it('key SET: a signature from a DIFFERENT key → FAILED', async () => {
    setKey();
    const receipt = sampleReceipt();
    const other = Wallet.createRandom();
    const hash = receiptContentHash(receipt);
    const foreign = await other.signMessage(signerCanonicalize({ v: 1, type: RECEIPT_SIGNATURE_TYPE, content_hash: hash }));
    const block: ReceiptSignature = {
      scheme: 'eip191-personal-sign', type: RECEIPT_SIGNATURE_TYPE, signer: ENGINE_ADDR,
      signature: foreign, content_hash: hash, signed_at: new Date().toISOString(),
    };
    expect(verifyReceiptSignature(receipt, block).status).toBe('FAILED');
  });

  it('key UNSET: signReceipt FAILS CLOSED (ok:false no_signing_key, never throws); verify → NOT_CHECKED', async () => {
    unsetKey();
    const res = await signReceipt(sampleReceipt());
    expect(res).toEqual({ ok: false, reason: 'no_signing_key', message: expect.any(String) });
    expect(receiptSignerAddress()).toBeNull();
    const v = verifyReceiptSignature(sampleReceipt(), { } as any);
    expect(v).toEqual({ status: 'NOT_CHECKED', reason: expect.any(String) });
  });

  it('key present but MALFORMED: signReceipt FAILS CLOSED, no key in the log', async () => {
    process.env.RECEIPT_SIGNING_KEY = 'not-a-valid-private-key';
    const logs: string[] = [];
    const errSpy = jest.spyOn(console, 'error').mockImplementation((...a: any[]) => { logs.push(a.join(' ')); });
    try {
      const res = await signReceipt(sampleReceipt());
      expect(res.ok).toBe(false);
      expect(receiptSignerAddress()).toBeNull();
    } finally { errSpy.mockRestore(); }
    expect(logs.join('\n')).not.toContain('not-a-valid-private-key');
  });

  it('the private key never appears in a return value', async () => {
    setKey();
    const res = await signReceipt(sampleReceipt());
    expect(JSON.stringify(res)).not.toContain(ENGINE_KEY);
    expect(String(receiptSignerAddress())).not.toContain(ENGINE_KEY);
  });
});

// ───────────────────────────── separation: receipt key ≠ payment key ─────────────────────────────

describe('receipt-signer separation — receipt-only, never a payment/user/custody key', () => {
  it('reads ONLY RECEIPT_SIGNING_KEY — does not fall back to a payment/custody key', async () => {
    unsetKey();
    // Set payment/custody keys that a confused signer might grab. The receipt signer must ignore them.
    process.env.APM_PRIVATE_KEY = Wallet.createRandom().privateKey;
    process.env.AGENT_KEY_MASTER = '0x' + 'ff'.repeat(32);
    process.env.DEPLOYER_PRIVATE_KEY = Wallet.createRandom().privateKey;
    try {
      expect(receiptSignerAddress()).toBeNull();
      expect((await signReceipt(sampleReceipt())).ok).toBe(false);
    } finally {
      delete process.env.APM_PRIVATE_KEY;
      delete process.env.AGENT_KEY_MASTER;
      delete process.env.DEPLOYER_PRIVATE_KEY;
    }
  });

  it('a receipt signature is NOT a valid x402/EIP-712 payment authorization', async () => {
    setKey();
    // The exact shape x402-outbound-client.ts signs (EIP-712 TransferWithAuthorization).
    const domain = { name: 'USD Coin', version: '2', chainId: 84532, verifyingContract: '0x' + '1'.repeat(40) };
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
      ],
    };
    const message = {
      from: '0x' + 'a'.repeat(40), to: '0x' + 'b'.repeat(40), value: '1000000',
      validAfter: '0', validBefore: '9999999999', nonce: '0x' + 'cd'.repeat(32),
    };
    // Hand the payment payload to the RECEIPT signer. It signs it AS A RECEIPT (EIP-191 personal_sign).
    const res = await signReceipt(message);
    expect(res.ok).toBe(true);
    const sig = (res as any).signature as ReceiptSignature;
    // It verifies as a receipt ...
    expect(verifyReceiptSignature(message, sig).status).toBe('VERIFIED');
    // ... but recovering it as an EIP-712 TransferWithAuthorization yields a DIFFERENT address:
    // a personal_sign over a receipt can never authorize a transfer. Money cannot move on it.
    const recovered = getAddress(verifyTypedData(domain, types, message, sig.signature));
    expect(recovered).not.toBe(ENGINE_ADDR);
  });

  it('source scan: the signer names no payment/user/custody key; payment signers name no receipt key', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
    const signerSrc = read('src/services/receipt-signer.ts');
    // Strip the header comment block (prose documents the boundary by naming these very envs).
    const code = signerSrc.slice(signerSrc.indexOf("import { Wallet"));
    for (const forbidden of ['_PRIVATE_KEY', 'AGENT_KEY_MASTER', 'ERC8004_', 'signTypedData', 'agent-key-crypto', 'x402']) {
      expect(code).not.toContain(forbidden);
    }
    expect(code).toContain('RECEIPT_SIGNING_KEY');
    // The payment signers must never read the receipt key.
    for (const f of ['src/services/x402-outbound-client.ts', 'src/services/x402-real-settler.ts']) {
      expect(read(f)).not.toContain('RECEIPT_SIGNING_KEY');
    }
  });
});

// ───────────────────────────── canonicalize consistency (dual-encoding guard) ─────────────────────────────

describe('canonicalize agrees with receipt-issuer so the two never drift', () => {
  it('matches on a battery of samples', () => {
    const samples: unknown[] = [
      { b: 2, a: 1 }, { x: { b: [3, 1], a: 2 } }, [2, 1], 'str', 42, true, null,
      { nested: { z: 1, a: { y: 2, x: [1, { q: 0, p: 1 }] } } },
      sampleReceipt(),
    ];
    for (const s of samples) expect(signerCanonicalize(s)).toBe(issuerCanonicalize(s));
  });
});

// ───────────────────────────── write path: issueReceipt ─────────────────────────────

describe('write path — issueReceipt wiring (fail-closed, flag-gated)', () => {
  it('flag OFF: the issued receipt is unchanged (no signature), one row written', async () => {
    disableFlag();
    setKey(); // key present but flag off → still no signing
    expect(receiptSigningEnabled()).toBe(false);
    const out = await issueReceipt(sampleIssueInput() as any);
    expect((out.receiptJson as any)[RECEIPT_SIGNATURE_FIELD]).toBeUndefined();
    expect(store().hyperdag_receipts).toHaveLength(1);
    expect((store().hyperdag_receipts[0].receipt_json as any)[RECEIPT_SIGNATURE_FIELD]).toBeUndefined();
  });

  it('flag ON + key SET: the receipt carries a verifiable engine_signature, persisted on the row', async () => {
    enableFlag();
    setKey();
    const out = await issueReceipt(sampleIssueInput() as any);
    const sig = (out.receiptJson as any)[RECEIPT_SIGNATURE_FIELD] as ReceiptSignature;
    expect(sig).toBeDefined();
    expect(sig.signer).toBe(ENGINE_ADDR);
    expect(verifyReceiptSignature(out.receiptJson)).toEqual({ status: 'VERIFIED', signer: ENGINE_ADDR });
    // persisted on the row and still verifies from storage
    const row = store().hyperdag_receipts[0];
    expect(verifyReceiptSignature(row.receipt_json)).toEqual({ status: 'VERIFIED', signer: ENGINE_ADDR });
    // the private key never reached the stored row
    expect(JSON.stringify(row)).not.toContain(ENGINE_KEY);
  });

  it('flag ON + key UNSET: issueReceipt THROWS and NO row is written (fail closed)', async () => {
    enableFlag();
    unsetKey();
    await expect(issueReceipt(sampleIssueInput() as any)).rejects.toBeInstanceOf(ReceiptSigningRequiredError);
    expect(store().hyperdag_receipts).toHaveLength(0);
  });

  it('flag ON + key MALFORMED: issueReceipt THROWS and NO row is written (fail closed)', async () => {
    enableFlag();
    process.env.RECEIPT_SIGNING_KEY = 'not-a-valid-private-key';
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(issueReceipt(sampleIssueInput() as any)).rejects.toBeInstanceOf(ReceiptSigningRequiredError);
    } finally { errSpy.mockRestore(); }
    expect(store().hyperdag_receipts).toHaveLength(0);
  });
});
