/**
 * AES-256-GCM encryption for trading credentials at rest.
 *
 * Format stored in JSONB:
 *   { v: 1, iv: <base64>, tag: <base64>, ciphertext: <base64> }
 *
 * Key derivation: TRADING_CREDS_ENCRYPTION_KEY env var. Must be either
 * 64 hex chars (32 bytes) or any string ≥ 32 chars (sha256 of which is
 * used as key). Demos can use the second form; prod sets a 32-byte hex.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { TradingCredentials } from './trading-bridge/types';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12; // GCM standard
const VERSION = 1;

function getKey(): Buffer {
  const raw = process.env.TRADING_CREDS_ENCRYPTION_KEY || 'reponomics-default-32-byte-encryption-key-please-rotate';
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  return createHash('sha256').update(raw).digest();
}

export interface EncryptedCreds {
  v: number;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function encryptCredentials(creds: TradingCredentials): EncryptedCreds {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = JSON.stringify(creds);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: VERSION,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: enc.toString('base64'),
  };
}

export function decryptCredentials(blob: EncryptedCreds): TradingCredentials {
  if (!blob || blob.v !== VERSION) {
    throw new Error(`unsupported encrypted creds version: ${blob?.v}`);
  }
  const key = getKey();
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const parsed = JSON.parse(dec.toString('utf8')) as TradingCredentials;
  if (!parsed.api_key || !parsed.secret_key) {
    throw new Error('decrypted credentials malformed');
  }
  return parsed;
}
