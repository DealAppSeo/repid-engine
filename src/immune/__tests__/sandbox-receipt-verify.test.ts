/**
 * sandbox-receipt-verify.test.ts — the harness signature is verified, fail-closed, over the canonical receipt.
 *
 * A throwaway Ed25519 key stands in for the ephemeral TrustShell harness key: the test signs the SAME bytes the
 * verifier checks (canonicalJson of `receipt`), exactly as a real sandbox would, so no real bundle is needed.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { signerFromPublicKey } from '../../kernel/receipt-signing';
import { canonicalJson } from '../../services/owner-authorization';
import { verifySandboxReceipt } from '../sandbox-receipt-verify';

/** A harness keypair and the base64url public key + 0x fingerprint it yields. */
function harness(): { key: KeyObject; pubB64url: string; fingerprint: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubB64url = String(publicKey.export({ format: 'jwk' }).x);
  const fp = signerFromPublicKey('0x' + Buffer.from(pubB64url, 'base64url').toString('hex'))!.fingerprint;
  return { key: privateKey, pubB64url, fingerprint: fp };
}

/** A `{ receipt, signature }` envelope signed exactly as the harness signs it. */
function signedEnvelope(h: ReturnType<typeof harness>, receiptOver: Record<string, unknown> = {}): { receipt: Record<string, unknown>; signature: string } {
  const receipt = {
    schema: 'trustshell.sandbox-mission-receipt/v2',
    mission_id: 'mission-abc',
    worker: { exit_code: 0 },
    destroy: { container_removed: true },
    keys: { harness: { alg: 'ed25519', public_key: h.pubB64url } },
    ...receiptOver,
  };
  const signature = sign(null, Buffer.from(canonicalJson(receipt), 'utf8'), h.key).toString('base64');
  return { receipt, signature };
}

describe('sandbox receipt harness-signature verification', () => {
  it('verifies a well-formed signed receipt (tamper-evidence), not yet authentic without a pin', () => {
    const h = harness();
    const v = verifySandboxReceipt(signedEnvelope(h));
    expect(v.verified).toBe(true);
    expect(v.harness_fingerprint).toBe(h.fingerprint);
    expect(v.pinned).toBe(false);
    expect(v.authentic).toBe(false); // ephemeral, self-asserted key: tamper-evident, not authority-pinned
    expect(v.reasons).toEqual([]);
  });

  it('REFUSES a receipt tampered after signing (any field changed breaks the signature)', () => {
    const h = harness();
    const env = signedEnvelope(h);
    (env.receipt as { worker: { exit_code: number } }).worker.exit_code = 137; // flip a field, keep the old signature
    const v = verifySandboxReceipt(env);
    expect(v.verified).toBe(false);
    expect(v.reasons).toContain('signature_invalid');
  });

  it('REFUSES a receipt signed by a DIFFERENT key than the one it embeds', () => {
    const h = harness();
    const env = signedEnvelope(h);
    env.signature = sign(null, Buffer.from(canonicalJson(env.receipt), 'utf8'), harness().key).toString('base64'); // wrong signer
    const v = verifySandboxReceipt(env);
    expect(v.verified).toBe(false);
    expect(v.reasons).toContain('signature_invalid');
  });

  it('fails closed on a missing signature / missing harness key / malformed envelope', () => {
    const h = harness();
    const env = signedEnvelope(h);
    expect(verifySandboxReceipt({ receipt: env.receipt }).reasons).toContain('signature_missing');
    expect(verifySandboxReceipt({ receipt: { mission_id: 'x' }, signature: env.signature }).reasons).toContain('harness_key_missing');
    expect(verifySandboxReceipt(null).reasons).toContain('envelope_malformed');
  });

  it('with a matching pin → authentic; with a non-matching pin → harness_not_pinned', () => {
    const h = harness();
    const ok = verifySandboxReceipt(signedEnvelope(h), { pinnedHarnessFingerprints: [h.fingerprint] });
    expect(ok.verified).toBe(true);
    expect(ok.pinned).toBe(true);
    expect(ok.authentic).toBe(true);

    const bad = verifySandboxReceipt(signedEnvelope(h), { pinnedHarnessFingerprints: ['0x' + 'ab'.repeat(32)] });
    expect(bad.verified).toBe(true); // signature still valid (tamper-evidence)
    expect(bad.pinned).toBe(false);
    expect(bad.authentic).toBe(false); // but not the pinned authority
    expect(bad.reasons).toContain('harness_not_pinned');
  });
});
