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
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard
export const KEY_VERSION = 1;

/** Resolve the symmetric master key from AGENT_KEY_MASTER. */
function getMasterKey(): Buffer {
  const raw = process.env.AGENT_KEY_MASTER;
  if (!raw || raw.length < 32) {
    // Loud failure: refusing to custody a private key under a weak/absent master
    // key is safer than silently using a default. Callers must handle this.
    throw new Error(
      'AGENT_KEY_MASTER is missing or too short (need 64 hex chars or a string ≥ 32 chars). ' +
        'Set a strong master key (KMS/Vault in production — see agent-key-crypto.ts header).'
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return createHash('sha256').update(raw).digest();
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
    v: KEY_VERSION,
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
  if (blob.v !== KEY_VERSION) {
    throw new Error(`unsupported encrypted key version: ${blob.v}`);
  }
  const key = getMasterKey();
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
