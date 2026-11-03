/**
 * immune/sandbox-receipt-verify.ts — verify the TrustShell sandbox-mission receipt's harness signature.
 *
 * The slice's Job B consumed the sandbox receipt as UNSIGNED data and re-derived facts from it. This verifies the
 * harness Ed25519 signature over the receipt, so a receipt TAMPERED after the sandbox signed it (any field changed
 * between the maker job and the settler) is caught. It REUSES the engine's `canonicalJson` (the bytes the harness
 * signs are the recursively key-sorted, compact JSON of `receipt` — verified empirically against real CI bundles)
 * and `verifyEd25519` — no new canonicalization, no new crypto. The signature on the real receipt is base64 raw
 * Ed25519 (64 bytes); the harness public key is base64url (32 bytes) at `receipt.keys.harness.public_key`.
 *
 * WHAT A PASS PROVES, AND WHAT IT DOES NOT. A valid signature proves the receipt is TAMPER-EVIDENT and internally
 * consistent under the key EMBEDDED in it. That harness key is EPHEMERAL per mission (it differs run to run) and is
 * self-asserted in the receipt, so this is NOT authenticity against a pinned authority: a hostile producer could
 * self-sign a fabricated receipt with its own key. Pass `pinnedHarnessFingerprints` (an allowlist) to ALSO require
 * the harness key be one we trust — only then is the receipt `authentic`. No pin is shipped yet (choosing the trust
 * anchor is Sean's MAJOR call), so by default this returns tamper-evidence, flagged `pinned:false`.
 */
import { verifyEd25519, signerFromPublicKey } from '../kernel/receipt-signing';
import { canonicalJson } from '../services/owner-authorization';

export interface SandboxReceiptVerification {
  /** the harness signature is valid over the canonical receipt — tamper-evidence + internal consistency. */
  verified: boolean;
  /** 0x + sha256 of the harness public key, COMPUTED here (never trusted from the receipt's own `fingerprint`). */
  harness_fingerprint: string | null;
  /** a pin allowlist was given AND the harness key is in it. */
  pinned: boolean;
  /** verified AND pinned — the only state safe to treat as a real trust anchor. */
  authentic: boolean;
  /** why it is not verified / not authentic (empty when verified and, if a pin was given, pinned). */
  reasons: string[];
}

const norm = (f: string): string => f.toLowerCase().replace(/^0x/, '');

/** base64url 32-byte Ed25519 public key → 0x + 64 hex, or null if it is not one. */
function pubKeyToHex(b64url: string): string | null {
  try {
    const b = Buffer.from(b64url, 'base64url');
    return b.length === 32 ? '0x' + b.toString('hex') : null;
  } catch {
    return null;
  }
}

/** base64 64-byte Ed25519 signature → 0x + 128 hex, or null if it is not one. */
function sigToHex(b64: string): string | null {
  try {
    const b = Buffer.from(b64, 'base64');
    return b.length === 64 ? '0x' + b.toString('hex') : null;
  } catch {
    return null;
  }
}

/**
 * Verify a TrustShell `{ receipt, signature }` envelope. Never throws. Fail-closed: a missing/malformed envelope,
 * key, or signature yields `verified:false` with a reason. When `pinnedHarnessFingerprints` is non-empty, the
 * harness key must be one of them for `authentic` to be true (else `harness_not_pinned`).
 */
export function verifySandboxReceipt(
  envelope: unknown,
  opts: { pinnedHarnessFingerprints?: readonly string[] } = {},
): SandboxReceiptVerification {
  const reasons: string[] = [];
  const fail = (reason: string): SandboxReceiptVerification => {
    reasons.push(reason);
    return { verified: false, harness_fingerprint: null, pinned: false, authentic: false, reasons };
  };

  if (envelope === null || typeof envelope !== 'object') return fail('envelope_malformed');
  const env = envelope as Record<string, unknown>;
  const receipt = env['receipt'];
  const signature = env['signature'];
  if (receipt === null || typeof receipt !== 'object') return fail('receipt_missing');
  if (typeof signature !== 'string') return fail('signature_missing');

  const harness = (receipt as { keys?: { harness?: { public_key?: unknown } } }).keys?.harness;
  const pubB64url = harness?.public_key;
  if (typeof pubB64url !== 'string') return fail('harness_key_missing');
  const pubHex = pubKeyToHex(pubB64url);
  if (pubHex === null) return fail('harness_key_malformed');
  const sigHex = sigToHex(signature);
  if (sigHex === null) return fail('signature_malformed');

  const fingerprint = signerFromPublicKey(pubHex)?.fingerprint ?? null;
  const verified = verifyEd25519(pubHex, canonicalJson(receipt), sigHex);
  if (!verified) reasons.push('signature_invalid');

  const pins = (opts.pinnedHarnessFingerprints ?? []).map(norm);
  const pinned = pins.length > 0 && fingerprint !== null && pins.includes(norm(fingerprint));
  if (pins.length > 0 && !pinned) reasons.push('harness_not_pinned');

  return { verified, harness_fingerprint: fingerprint, pinned, authentic: verified && pinned, reasons };
}
