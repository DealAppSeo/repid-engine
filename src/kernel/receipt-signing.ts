/**
 * kernel/receipt-signing.ts — the Ed25519 key that seals kernel-receipt/2 (RT-7).
 *
 * WHY. kernel-receipt/1 is "a hash and a chain": keccak256 needs no key, so anyone who copies a
 * genuine receipt's format can mint one that validates (red-team RT-7). A signature from a key only
 * the engine holds is what makes a receipt AUTHENTIC, which is a separate question from WELL-FORMED.
 *
 * INERT UNTIL A KEY IS SET. With KERNEL_RECEIPT_SIGNING_KEY unset the kernel emits kernel-receipt/1
 * byte-for-byte as before. Set, every receipt is kernel-receipt/2 and carries header.signer (public
 * key + fingerprint) and header.signature.
 *
 *   KERNEL_RECEIPT_SIGNING_KEY       the engine's Ed25519 private key, PKCS8 DER, base64. Sean-only env.
 *   KERNEL_RECEIPT_TRUSTED_SIGNERS   comma-separated Ed25519 PUBLIC keys (0x + 64 hex) a verifier
 *                                    accepts. Never derived from the signing key: it is an independent
 *                                    pin, so a wrong key pasted into the signing variable shows up as
 *                                    NOT_AUTHENTIC instead of silently trusting itself. Keep a retired
 *                                    key listed for as long as its receipts must verify.
 *
 * A key that is SET but unusable throws (a fixed message, never the key), so the ledger write fails
 * and the tool does not run: fail closed, never a silent fall back to unsigned receipts.
 *
 * THE KEY NEVER LEAVES. Only the public key and the signature are ever returned; and the signer
 * refuses to sign a receipt whose bytes contain its own private key in any common encoding.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import type { ReceiptSigner } from './types';

/** Prefixed to the signed bytes, so a kernel receipt signature can never be replayed as anything else. */
export const KERNEL_RECEIPT_SIGNATURE_DOMAIN = 'hyperdag.kernel-receipt.signature.v1\n';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const SIG_HEX = /^0x[0-9a-fA-F]{128}$/;

function publicKeyFromHex(hex: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex.slice(2), 'hex').toString('base64url') }, format: 'jwk' });
}

/** The signer block for a raw public key (0x + 64 hex), or null when it is not one. */
export function signerFromPublicKey(hex: string): ReceiptSigner | null {
  if (!HEX32.test(hex)) return null;
  try {
    publicKeyFromHex(hex);
  } catch {
    return null;
  }
  const raw = Buffer.from(hex.slice(2), 'hex');
  return { alg: 'ed25519', public_key: `0x${raw.toString('hex')}`, fingerprint: `0x${createHash('sha256').update(raw).digest('hex')}` };
}

/** true when `signatureHex` is a valid Ed25519 signature of `message` by `publicKeyHex`. Never throws. */
export function verifyEd25519(publicKeyHex: string, message: string, signatureHex: string): boolean {
  if (!HEX32.test(publicKeyHex) || !SIG_HEX.test(signatureHex)) return false;
  try {
    return verify(null, Buffer.from(message, 'utf8'), publicKeyFromHex(publicKeyHex), Buffer.from(signatureHex.slice(2), 'hex'));
  } catch {
    return false;
  }
}

export interface KernelReceiptSigningKey {
  signer: ReceiptSigner;
  /** Ed25519 signature of `message`, 0x + 128 hex. */
  sign(message: string): string;
  /** true when `text` contains this private key in any common encoding. */
  leaks(text: string): boolean;
}

/**
 * The configured signing key, or null when KERNEL_RECEIPT_SIGNING_KEY is unset. Read per call so the
 * env can be flipped (and tested) without a reload. THROWS when the variable is set but is not an
 * Ed25519 PKCS8 key: the message is fixed and carries no key bytes.
 */
export function kernelReceiptSigningKey(): KernelReceiptSigningKey | null {
  const raw = (process.env['KERNEL_RECEIPT_SIGNING_KEY'] ?? '').trim();
  if (raw === '') return null;
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
  } catch {
    // Never the error object: it can echo key bytes.
    throw new Error('[kernel] KERNEL_RECEIPT_SIGNING_KEY is set but is not an Ed25519 PKCS8 key (base64); refusing to seal receipts');
  }
  const jwk = key.export({ format: 'jwk' });
  const signer = signerFromPublicKey(`0x${Buffer.from(String(jwk.x), 'base64url').toString('hex')}`)!;
  const seed = Buffer.from(String(jwk.d), 'base64url');
  const der = Buffer.from(raw, 'base64');
  const encodings = [der.toString('base64'), der.toString('base64url'), seed.toString('base64'), seed.toString('base64url')].map((s) => s.replace(/=+$/, ''));
  const seedHex = seed.toString('hex');
  return {
    signer,
    sign: (message) => `0x${sign(null, Buffer.from(message, 'utf8'), key).toString('hex')}`,
    leaks: (text) => encodings.some((e) => text.includes(e)) || text.toLowerCase().includes(seedHex),
  };
}

/**
 * The public keys a verifier accepts, from KERNEL_RECEIPT_TRUSTED_SIGNERS. One malformed entry voids
 * the whole list (logged): fail closed means trusting fewer keys, never guessing.
 */
export function trustedKernelReceiptSigners(): ReceiptSigner[] {
  const raw = (process.env['KERNEL_RECEIPT_TRUSTED_SIGNERS'] ?? '').trim();
  if (raw === '') return [];
  const out: ReceiptSigner[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    const s = signerFromPublicKey(entry);
    if (s === null) {
      console.error('[kernel] KERNEL_RECEIPT_TRUSTED_SIGNERS has an entry that is not an Ed25519 public key (0x + 64 hex); trusting none');
      return [];
    }
    out.push(s);
  }
  return out;
}
