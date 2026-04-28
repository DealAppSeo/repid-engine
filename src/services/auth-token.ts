/**
 * JWT-backed full-account auth tokens.
 *
 * Replaces the hand-rolled HMAC-over-base64url scheme in
 * src/services/full-account-token.ts with `jsonwebtoken`. Algorithm HS256,
 * 7-day expiry, secret from FULL_ACCOUNT_JWT_SECRET (already provisioned
 * in Railway).
 *
 * Contract:
 *   issueFullAccountToken(builderId, email)        → JWT string
 *   verifyFullAccountToken(token)                  → payload | null
 *     - returns null on any error (expired, malformed, tampered, missing).
 *     - never throws at call time.
 *
 * The secret env var is read lazily (so importing this module in tests
 * that mock or omit it does not blow up). issueFullAccountToken throws
 * with a clear message if the secret is unset; verifyFullAccountToken
 * returns null in that case (we do not let auth-decisions leak as
 * uncaught exceptions in request handlers).
 */

import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';

const ALGORITHM = 'HS256' as const;
const EXPIRY = '7d' as const;

export interface FullAccountTokenPayload {
  builder_id: string;
  email: string;
}

function readSecret(): string {
  const s = process.env.FULL_ACCOUNT_JWT_SECRET;
  if (!s || s.length === 0) {
    throw new Error('FULL_ACCOUNT_JWT_SECRET is not set');
  }
  return s;
}

export function issueFullAccountToken(builderId: string, email: string): string {
  const secret = readSecret();
  const payload: FullAccountTokenPayload = {
    builder_id: builderId,
    email: email.toLowerCase(),
  };
  const opts: SignOptions = { algorithm: ALGORITHM, expiresIn: EXPIRY };
  return jwt.sign(payload, secret, opts);
}

export function verifyFullAccountToken(token: string): FullAccountTokenPayload | null {
  if (!token || typeof token !== 'string') return null;
  let secret: string;
  try {
    secret = readSecret();
  } catch {
    return null;
  }
  try {
    const decoded = jwt.verify(token, secret, { algorithms: [ALGORITHM] }) as JwtPayload | string;
    if (typeof decoded === 'string') return null;
    const builderId = decoded.builder_id;
    const email = decoded.email;
    if (typeof builderId !== 'string' || typeof email !== 'string') return null;
    return { builder_id: builderId, email };
  } catch {
    return null;
  }
}
