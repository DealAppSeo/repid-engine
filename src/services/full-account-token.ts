/**
 * Hand-rolled HMAC login token for full-account builders.
 *
 * Format: base64url(payload).base64url(hmac_sha256(payload, secret))
 * Payload JSON: { builder_id, email, exp }  (exp = unix seconds)
 *
 * No external JWT lib — keeps deps slim and avoids the SQL-keyword
 * sanitizer corner cases (a JWT can contain '+' and '/' which are
 * benign here; we use base64url which avoids '+' / '/').
 *
 * Default expiry: 7 days. Secret comes from FULL_ACCOUNT_JWT_SECRET env.
 */

import { createHmac, timingSafeEqual } from 'crypto';

const DEFAULT_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // 7 days

function getSecret(): string {
  return process.env.FULL_ACCOUNT_JWT_SECRET || 'reponomics-default-full-account-secret';
}

function b64url(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export interface TokenPayload {
  builder_id: string;
  email: string;
  exp: number;
}

export function issueLoginToken(builderId: string, email: string, expirySeconds = DEFAULT_EXPIRY_SECONDS): string {
  const payload: TokenPayload = {
    builder_id: builderId,
    email: email.toLowerCase(),
    exp: Math.floor(Date.now() / 1000) + expirySeconds,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', getSecret()).update(payloadB64).digest();
  return `${payloadB64}.${b64url(sig)}`;
}

export interface VerifyResult {
  ok: boolean;
  payload?: TokenPayload;
  error?: string;
}

export function verifyLoginToken(token: string): VerifyResult {
  if (!token || typeof token !== 'string') return { ok: false, error: 'missing token' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, error: 'malformed token' };
  const [payloadB64, sigB64] = parts as [string, string];

  const expectedSig = createHmac('sha256', getSecret()).update(payloadB64).digest();
  let providedSig: Buffer;
  try {
    providedSig = b64urlDecode(sigB64);
  } catch {
    return { ok: false, error: 'invalid signature encoding' };
  }
  if (providedSig.length !== expectedSig.length) return { ok: false, error: 'signature length mismatch' };
  if (!timingSafeEqual(providedSig, expectedSig)) return { ok: false, error: 'signature mismatch' };

  let payload: TokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, error: 'invalid payload json' };
  }
  if (!payload.builder_id || !payload.email || typeof payload.exp !== 'number') {
    return { ok: false, error: 'incomplete payload' };
  }
  if (Math.floor(Date.now() / 1000) > payload.exp) {
    return { ok: false, error: 'token expired' };
  }
  return { ok: true, payload };
}
