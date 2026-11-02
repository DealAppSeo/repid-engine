/**
 * Signed kernel receipts (kernel-receipt/2), RT-7. Lane D, 2026-11-02.
 *
 * Keys are generated in memory per test (generateKeyPairSync), never written, never logged. The env
 * variables are set for one test and restored after it.
 *
 * The four answers a verifier can get, and what earns each:
 *   AUTHENTIC        well-formed, the signature verifies, and the signing key is in the trusted list.
 *   NOT_AUTHENTIC    unsigned (v1), malformed or tampered, or signed by a key that is not trusted.
 *   NOT_CHECKED      signed, but no trusted key is configured. Never a pass.
 */
import { generateKeyPairSync } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { RECEIPT_UNSIGNED_NOTE } from '../../src/kernel/decide';
import { runUnderKernel } from '../../src/kernel/gate';
import { receiptHash, validateReceipt, verifyReceiptAuthenticity, verifyReceiptChain } from '../../src/kernel/receipt';
import { signerFromPublicKey } from '../../src/kernel/receipt-signing';
import { receiptSignersHandler } from '../../src/routes/kernel';
import type { GateDeps, KernelReceipt } from '../../src/kernel/types';
import { AGENT_ID, harness, iso, signedPolicy, spendRequest } from '../../src/kernel/__tests__/fixtures';

const ENV = ['KERNEL_RECEIPT_SIGNING_KEY', 'KERNEL_RECEIPT_TRUSTED_SIGNERS'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => ENV.forEach((k) => ((saved[k] = process.env[k]), delete process.env[k])));
afterEach(() => ENV.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]))));

/** A fresh Ed25519 key in the formats the env takes: PKCS8 base64 (private) and 0x hex (public). */
function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    pkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicHex: `0x${Buffer.from(String(publicKey.export({ format: 'jwk' }).x), 'base64url').toString('hex')}`,
    seedB64url: String(jwk.d),
  };
}

async function armed(over: Partial<GateDeps> = {}) {
  const h = harness(over);
  await h.ledger.appendPolicy(await signedPolicy(h.owner, { per_tx_raw: '1000000' }), iso);
  return h;
}

async function spendReceipt(amount = '1'): Promise<KernelReceipt> {
  const h = await armed();
  const out = await runUnderKernel(spendRequest({ amount_raw: amount }), jest.fn(async () => 1), h.deps);
  expect(out.verdict).toBe('ALLOW');
  return out.decision_receipt!;
}

const clone = (r: KernelReceipt): KernelReceipt => JSON.parse(JSON.stringify(r)) as KernelReceipt;

describe('no key configured: today\'s behaviour, unchanged', () => {
  it('the kernel emits kernel-receipt/1 with signer null, no signature field, the "unsigned" line, and validateReceipt is exactly { ok: true }', async () => {
    const r = await spendReceipt();
    expect(r.header.schema).toBe('kernel-receipt/1');
    expect(r.header.version).toBe(1);
    expect(r.header.signer).toBeNull();
    expect(Object.keys(r.header).sort()).toEqual(['created_at', 'env', 'prev_hash', 'prev_receipt_id', 'receipt_hash', 'receipt_id', 'schema', 'signer', 'version']);
    expect(r.decision.does_not_attest).toContain(RECEIPT_UNSIGNED_NOTE);
    expect(validateReceipt(r)).toEqual({ ok: true });
  });

  it('an unsigned v1 receipt is well-formed but NOT authentic, whether or not trusted signers are configured', async () => {
    const r = await spendReceipt();
    expect(verifyReceiptAuthenticity(r, [])).toMatchObject({ status: 'NOT_AUTHENTIC', reason: 'unsigned' });
    process.env['KERNEL_RECEIPT_TRUSTED_SIGNERS'] = newKey().publicHex; // signing required by this verifier
    expect(verifyReceiptAuthenticity(r)).toMatchObject({ status: 'NOT_AUTHENTIC', reason: 'unsigned' });
  });

  it('GET /receipt-signers is 404 not_configured', async () => {
    const app = express().get('/s', receiptSignersHandler);
    const res = await request(app).get('/s');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('not_configured');
  });
});

describe('signing key configured: kernel-receipt/2', () => {
  it('a genuine signed receipt is well-formed and AUTHENTIC against a trusted list holding its key', async () => {
    const k = newKey();
    process.env['KERNEL_RECEIPT_SIGNING_KEY'] = k.pkcs8;
    process.env['KERNEL_RECEIPT_TRUSTED_SIGNERS'] = k.publicHex;
    const r = await spendReceipt();
    expect(r.header.schema).toBe('kernel-receipt/2');
    expect(r.header.signer).toEqual(signerFromPublicKey(k.publicHex));
    expect(r.header.signature).toMatch(/^0x[0-9a-f]{128}$/);
    expect(r.decision.does_not_attest).not.toContain(RECEIPT_UNSIGNED_NOTE);
    expect(validateReceipt(r)).toEqual({ ok: true });
    expect(verifyReceiptAuthenticity(r)).toEqual({ status: 'AUTHENTIC', fingerprint: r.header.signer!.fingerprint });
  });

  it('signed but no trusted signer configured: NOT_CHECKED, never a pass', async () => {
    process.env['KERNEL_RECEIPT_SIGNING_KEY'] = newKey().pkcs8;
    expect(verifyReceiptAuthenticity(await spendReceipt())).toMatchObject({ status: 'NOT_CHECKED' });
  });

  it('RT-7 with signing on: a forger who edits a genuine signed receipt and reseals the hash, without the key, is NOT authentic', async () => {
    const k = newKey();
    process.env['KERNEL_RECEIPT_SIGNING_KEY'] = k.pkcs8;
    process.env['KERNEL_RECEIPT_TRUSTED_SIGNERS'] = k.publicHex;
    const f = clone(await spendReceipt());
    f.request.amount_raw = '999';
    f.payment.amount_raw = '999';
    f.header.receipt_hash = receiptHash(f);
    expect(validateReceipt(f)).toMatchObject({ ok: false, errors: [expect.objectContaining({ code: 'signature_invalid' })] });
    expect(verifyReceiptAuthenticity(f)).toMatchObject({ status: 'NOT_AUTHENTIC', reason: 'invalid' });
  });

  it('one byte changed anywhere in a signed receipt fails: in the body (hash and signature) and in the signature itself', async () => {
    const k = newKey();
    process.env['KERNEL_RECEIPT_SIGNING_KEY'] = k.pkcs8;
    process.env['KERNEL_RECEIPT_TRUSTED_SIGNERS'] = k.publicHex;
    const r = await spendReceipt();
    const body = clone(r);
    body.subject.agent.agent_name = body.subject.agent.agent_name + 'x';
    expect(verifyReceiptAuthenticity(body).status).toBe('NOT_AUTHENTIC');
    const sig = clone(r);
    const last = sig.header.signature!.slice(-1);
    sig.header.signature = sig.header.signature!.slice(0, -1) + (last === '0' ? '1' : '0');
    sig.header.receipt_hash = receiptHash(sig); // even resealed, the signature is wrong
    expect(validateReceipt(sig).ok).toBe(false);
    expect(verifyReceiptAuthenticity(sig).status).toBe('NOT_AUTHENTIC');
    const upper = clone(r); // the same signature, re-encoded: not a second valid receipt
    upper.header.signature = '0x' + r.header.signature!.slice(2).toUpperCase();
    upper.header.receipt_hash = receiptHash(upper);
    expect(validateReceipt(upper).ok).toBe(false);
  });

  it('a receipt properly signed by a key that is NOT trusted is well-formed but NOT authentic (the forger\'s own key)', async () => {
    const engine = newKey();
    const forger = newKey();
    process.env['KERNEL_RECEIPT_SIGNING_KEY'] = forger.pkcs8;
    process.env['KERNEL_RECEIPT_TRUSTED_SIGNERS'] = engine.publicHex;
    const r = await spendReceipt();
    expect(validateReceipt(r)).toEqual({ ok: true });
    expect(verifyReceiptAuthenticity(r)).toMatchObject({ status: 'NOT_AUTHENTIC', reason: 'untrusted_signer' });
  });

  it('a retired key stays trusted while listed: the trusted list accepts more than one key', async () => {
    const old = newKey();
    const cur = newKey();
    process.env['KERNEL_RECEIPT_SIGNING_KEY'] = old.pkcs8;
    const r = await spendReceipt();
    process.env['KERNEL_RECEIPT_SIGNING_KEY'] = cur.pkcs8;
    process.env['KERNEL_RECEIPT_TRUSTED_SIGNERS'] = `${cur.publicHex}, ${old.publicHex}`;
    expect(verifyReceiptAuthenticity(r).status).toBe('AUTHENTIC');
    process.env['KERNEL_RECEIPT_TRUSTED_SIGNERS'] = `${cur.publicHex},not-a-key`; // one bad entry voids the list
    expect(verifyReceiptAuthenticity(r).status).toBe('NOT_CHECKED');
  });

  it('the chain still verifies across signed entries, and an edit still breaks it', async () => {
    process.env['KERNEL_RECEIPT_SIGNING_KEY'] = newKey().pkcs8;
    const h = await armed();
    for (let i = 1; i <= 3; i++) await runUnderKernel(spendRequest({ amount_raw: String(i) }), jest.fn(async () => 1), h.deps);
    const rs = h.sink.records.flatMap((x) => (x.kind === 'receipt' ? [x.receipt] : []));
    expect(rs.length).toBeGreaterThanOrEqual(3);
    expect(rs.every((r) => r.header.schema === 'kernel-receipt/2')).toBe(true);
    expect(verifyReceiptChain(rs)).toEqual({ ok: true });
    const edited = rs.map(clone);
    edited[2]!.request.amount_raw = '1';
    expect(verifyReceiptChain(edited).ok).toBe(false);
  });

  it('GET /receipt-signers returns public keys and fingerprints only, never private material', async () => {
    const k = newKey();
    process.env['KERNEL_RECEIPT_SIGNING_KEY'] = k.pkcs8;
    process.env['KERNEL_RECEIPT_TRUSTED_SIGNERS'] = k.publicHex;
    const app = express().get('/s', receiptSignersHandler);
    const res = await request(app).get('/s');
    expect(res.status).toBe(200);
    expect(res.body.current).toEqual(signerFromPublicKey(k.publicHex));
    expect(res.body.trusted).toEqual([signerFromPublicKey(k.publicHex)]);
    expect(res.text).not.toContain(k.pkcs8);
    expect(res.text).not.toContain(k.seedB64url);
  });
});

describe('the signing key can never be written into a receipt', () => {
  it('positive control: with no key set, the same request carrying an opaque string as agent_name is ALLOWED', async () => {
    const h = await armed();
    const tool = jest.fn(async () => 1);
    const out = await runUnderKernel(spendRequest({ agent: { agent_id: AGENT_ID, agent_name: newKey().seedB64url } }), tool, h.deps);
    expect(out.verdict).toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(1);
  });

  it('the signer refuses to seal a receipt that contains its own private key, so the ledger write fails and the tool does not run', async () => {
    const k = newKey();
    process.env['KERNEL_RECEIPT_SIGNING_KEY'] = k.pkcs8;
    const h = await armed();
    const tool = jest.fn(async () => 1);
    const out = await runUnderKernel(spendRequest({ agent: { agent_id: AGENT_ID, agent_name: k.seedB64url } }), tool, h.deps);
    expect(out.verdict).not.toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(0);
    expect(JSON.stringify(h.sink.records)).not.toContain(k.seedB64url);
  });

  it('any Ed25519 PKCS8 private key in a receipt field is secret-shaped material, key configured or not', async () => {
    const r = clone(await spendReceipt());
    r.subject.agent.agent_name = newKey().pkcs8;
    r.header.receipt_hash = receiptHash(r);
    const v = validateReceipt(r);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code)).toContain('secret_shaped_material');
  });

  it('a key that is set but unusable fails closed: no receipt is written and the tool does not run', async () => {
    process.env['KERNEL_RECEIPT_SIGNING_KEY'] = 'bm90LWEta2V5';
    const h = await armed();
    const tool = jest.fn(async () => 1);
    const out = await runUnderKernel(spendRequest({ amount_raw: '1' }), tool, h.deps);
    expect(out.verdict).not.toBe('ALLOW');
    expect(tool).toHaveBeenCalledTimes(0);
    expect(h.sink.records.filter((x) => x.kind === 'receipt')).toHaveLength(0);
  });
});
