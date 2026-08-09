/**
 * mesh-memory/crypto.ts — real symmetric primitives for the SSE memory cell.
 *
 * SANDBOX / SHADOW module. Nothing here touches production tables, RepID, or
 * on-chain state. It is a self-contained, dependency-free (node:crypto only)
 * searchable-symmetric-encryption cell for the agent mesh-memory experiment.
 *
 * Everything in this file is REAL cryptography:
 *   - AES-256-GCM (authenticated encryption) for record payloads and postings.
 *   - HMAC-SHA256 for deterministic keyword search tokens.
 *   - HKDF-SHA256 for deriving independent subkeys from one user master key.
 *
 * What it is NOT: zero-knowledge. See sse-cell.ts for the honest leakage
 * profile of the scheme these primitives compose into.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard nonce length
const KEY_LEN = 32; // AES-256

/** An AES-256-GCM ciphertext blob. All fields base64. */
export interface GcmBlob {
  iv: string;
  tag: string;
  ct: string;
}

/**
 * Derive a 32-byte master key from arbitrary user key material.
 * Accepts 64 hex chars (32 bytes) as-is, otherwise sha256(input). Mirrors the
 * house convention in agent-key-crypto.ts / trading-creds-crypto.ts.
 */
export function toMasterKey(userKey: string): Buffer {
  if (!userKey || userKey.length < 16) {
    throw new Error('mesh-memory: user key material too short (need >= 16 chars, 64 hex preferred)');
  }
  if (/^[0-9a-fA-F]{64}$/.test(userKey)) {
    return Buffer.from(userKey, 'hex');
  }
  return createHash('sha256').update(userKey, 'utf8').digest();
}

/**
 * HKDF-SHA256 subkey derivation. `salt` is the per-cell public salt (non-secret);
 * `info` binds the subkey to its purpose so token/postings/record keys are
 * cryptographically independent even though they share one master.
 */
export function deriveSubkey(master: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, salt, Buffer.from(info, 'utf8'), KEY_LEN));
}

/** AES-256-GCM encrypt. Random IV per call — never reuse an IV under one key. */
export function gcmEncrypt(key: Buffer, plaintext: Buffer | string): GcmBlob {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const pt = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
}

/**
 * AES-256-GCM decrypt. Throws on a bad key or tampered ciphertext (the GCM tag
 * fails to verify) — this is what makes a wrong key unable to read a record.
 */
export function gcmDecrypt(key: Buffer, blob: GcmBlob): Buffer {
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/**
 * Deterministic search token for a keyword: HMAC-SHA256(K_tok, normalize(w)).
 * Deterministic so the same keyword always maps to the same token (that is what
 * makes single-keyword lookup possible without decrypting the store). The HMAC
 * hides the keyword from anyone without K_tok. Returns lowercase hex.
 */
export function keywordToken(tokenKey: Buffer, keyword: string): string {
  return createHmac('sha256', tokenKey).update(normalizeKeyword(keyword)).digest('hex');
}

/** Lowercase + trim + collapse internal whitespace, so "Ada  Lovelace" == "ada lovelace". */
export function normalizeKeyword(keyword: string): string {
  return keyword.toLowerCase().trim().replace(/\s+/g, ' ');
}

/** SHA-256 hex of a buffer/string — used by the Merkle commitment. */
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
}

/** Constant-time hex-string equality (for tag/proof comparisons in tests). */
export function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export { randomBytes };
