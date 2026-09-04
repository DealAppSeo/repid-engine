/**
 * AES-256-GCM encryption for agent-custodied wallet private keys at rest.
 *
 * ── SECURITY FLAG (human review required — Sean's call) ─────────────────────
 * This is APPLICATION-LEVEL custody using a single symmetric master key held
 * in an env var (AGENT_KEY_MASTER). It is the INTERIM scheme so a new human's
 * agent can transact today. The PRODUCTION upgrade is a KMS / Vault-backed key:
 *   - AWS KMS / GCP KMS envelope encryption (data key per secret), OR
 *   - HashiCorp Vault transit engine (never expose the raw master to the app).
 * The master-key vs KMS decision is a human/Sean decision — DO NOT ship the
 * env-var scheme to real user funds without that sign-off.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Stored format (per agent_secrets.encrypted_private_key JSONB / text):
 *   { v: 1, iv: <base64>, tag: <base64>, ciphertext: <base64> }
 *
 * Key derivation mirrors trading-creds-crypto.ts: AGENT_KEY_MASTER must be
 * either 64 hex chars (32 bytes) or any string ≥ 32 chars (sha256 → key).
 * `key_version` in the DB row tracks which master-key generation encrypted the
 * blob so rotation can decrypt-old / re-encrypt-new without ambiguity.
 *
 * ── ROTATION: THE CAPABILITY THIS HEADER CLAIMED, AND THE CHECK THAT FORBADE IT
 * The paragraph above has promised "rotation can decrypt-old / re-encrypt-new"
 * since this file was written. It could not. `decryptPrivateKey` threw on any
 * `blob.v !== KEY_VERSION`, and `KEY_VERSION` was a hardcoded `1` — so the
 * moment you rotated the master key and began writing v2, every v1 blob became
 * PERMANENTLY UNDECRYPTABLE by the only code that could have re-encrypted it.
 * The version field existed, the column existed, and the one operation they
 * were both for was foreclosed by a one-line equality check.
 *
 * That is worse than an absent feature. An absent feature is visible; this read
 * as present. `rotated_at` sits in the BYOK row shape, the header describes the
 * procedure, and nothing in the codebase could perform it — a compromised master
 * key had no remediation path but abandoning every custodied wallet.
 *
 * How it works now. Each generation's key lives in `AGENT_KEY_MASTER_V<n>`;
 * `AGENT_KEY_MASTER` is the current generation, named by
 * `AGENT_KEY_MASTER_VERSION` (default 1). Decryption resolves the master for the
 * blob's OWN version, so old blobs stay readable exactly as long as their key is
 * still provisioned. Encryption always writes the current version, so a rotated
 * deployment stops producing old-generation blobs immediately.
 *
 * Rotating, in order:
 *   1. Keep the outgoing key, renamed to its own version:  AGENT_KEY_MASTER_V1=<old>
 *   2. Set the incoming key and bump the generation:       AGENT_KEY_MASTER=<new>
 *                                                          AGENT_KEY_MASTER_VERSION=2
 *   3. Re-encrypt each stored blob with `rotateEncryptedKey`, writing the
 *      returned `v` back to the row's `key_version`.
 *   4. Only once no row reports the old version, retire AGENT_KEY_MASTER_V1.
 *
 * Step 1 is load-bearing and is the step an operator skips: drop the old key
 * before step 3 completes and the remaining blobs are unrecoverable. Decryption
 * fails LOUD and names the missing variable for exactly that reason.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard

/**
 * The DEFAULT generation, not the only one.
 *
 * Kept exported and kept at 1 so an unrotated deployment behaves byte-identically
 * to before. Do NOT use it to stamp a `key_version` column — use the `v` on the
 * blob you actually produced (`encryptPrivateKey(...).v`), or the column will
 * disagree with the ciphertext the first time anyone rotates.
 */
export const KEY_VERSION = 1;

/** The generation new ciphertext is written at. `AGENT_KEY_MASTER_VERSION`, default 1. */
export function currentKeyVersion(): number {
  const raw = (process.env.AGENT_KEY_MASTER_VERSION ?? '').trim();
  if (raw === '') return KEY_VERSION;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `AGENT_KEY_MASTER_VERSION must be a positive integer, got '${raw}'. ` +
        'Refusing to guess which master key encrypted anything.'
    );
  }
  return n;
}

function deriveKey(raw: string): Buffer {
  return /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : createHash('sha256').update(raw).digest();
}

/**
 * Resolve the master key for one generation.
 *
 * `AGENT_KEY_MASTER_V<n>` wins when present; `AGENT_KEY_MASTER` serves the
 * current generation. An unrotated deployment sets only `AGENT_KEY_MASTER`, so
 * version 1 resolves to it and nothing changes.
 */
function masterKeyForVersion(version: number): Buffer {
  const explicit = process.env[`AGENT_KEY_MASTER_V${version}`];
  const raw = explicit ?? (version === currentKeyVersion() ? process.env.AGENT_KEY_MASTER : undefined);

  if (!raw || raw.length < 32) {
    // Loud failure: refusing to custody a private key under a weak/absent master
    // key is safer than silently using a default. Callers must handle this.
    //
    // Naming the exact variable matters here — this is the error an operator hits
    // mid-rotation after retiring an old key too early, and a generic message
    // would leave them guessing which generation is unreadable.
    const want = version === currentKeyVersion() ? 'AGENT_KEY_MASTER' : `AGENT_KEY_MASTER_V${version}`;
    throw new Error(
      `${want} is missing or too short (need 64 hex chars or a string ≥ 32 chars) — ` +
        `cannot handle key_version ${version}. ` +
        (version === currentKeyVersion()
          ? 'Set a strong master key (KMS/Vault in production — see agent-key-crypto.ts header).'
          : `This blob predates the current generation (${currentKeyVersion()}). Restore the ` +
            `retired key as AGENT_KEY_MASTER_V${version} to read or rotate it.`)
    );
  }
  return deriveKey(raw);
}

/** Resolve the symmetric master key for the CURRENT generation. */
function getMasterKey(): Buffer {
  return masterKeyForVersion(currentKeyVersion());
}

export interface EncryptedKeyBlob {
  v: number;
  iv: string;
  tag: string;
  ciphertext: string;
}

/** Encrypt a wallet private key (0x-hex string) for at-rest storage. */
export function encryptPrivateKey(privateKey: string): EncryptedKeyBlob {
  const key = getMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: currentKeyVersion(),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: enc.toString('base64'),
  };
}

/** Decrypt an at-rest blob back to the 0x-hex private key string. */
export function decryptPrivateKey(blob: EncryptedKeyBlob): string {
  if (!blob || typeof blob !== 'object') {
    throw new Error('encrypted private key blob missing or malformed');
  }
  if (!Number.isInteger(blob.v) || blob.v < 1) {
    throw new Error(`unsupported encrypted key version: ${blob.v}`);
  }
  // Resolve the master for the blob's OWN generation, not the current one. This
  // single line is what makes rotation possible: the old check compared against a
  // hardcoded 1 and stranded every prior-generation blob the moment you rotated.
  const key = masterKeyForVersion(blob.v);
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const pk = dec.toString('utf8');
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error('decrypted value is not a well-formed private key');
  }
  return pk;
}

/**
 * Re-encrypt a stored blob under the current master-key generation.
 *
 * Pure: takes a blob, returns a blob. The caller persists the result and writes
 * the returned `v` back to the row's `key_version` — the column must mirror the
 * ciphertext, never a compile-time constant.
 *
 * A blob already at the current generation is returned UNCHANGED with
 * `rotated: false`, so a rotation sweep is idempotent and re-runnable after a
 * partial failure. It deliberately does not re-encrypt in that case: churning
 * ciphertext that is already current buys nothing and would make "how many rows
 * are left" unanswerable.
 *
 * Throws if the blob's own generation key is not provisioned — see the header on
 * why retiring an old key before the sweep finishes is unrecoverable.
 */
export function rotateEncryptedKey(blob: EncryptedKeyBlob): {
  blob: EncryptedKeyBlob;
  rotated: boolean;
  fromVersion: number;
  toVersion: number;
} {
  const to = currentKeyVersion();
  if (blob && typeof blob === 'object' && blob.v === to) {
    return { blob, rotated: false, fromVersion: to, toVersion: to };
  }
  // decrypt -> re-encrypt. `decryptPrivateKey` re-validates the plaintext shape,
  // so a blob that decrypts to something that is not a private key fails here
  // rather than being faithfully re-encrypted as garbage.
  const plaintext = decryptPrivateKey(blob);
  const next = encryptPrivateKey(plaintext);
  return { blob: next, rotated: true, fromVersion: blob.v, toVersion: next.v };
}
