/**
 * JWT-backed full-account auth token tests.
 *
 * Covers: round-trip, tampered signature, expired token, malformed
 * input, missing FULL_ACCOUNT_JWT_SECRET env var.
 *
 * Each test sets/restores the env var explicitly because issueFullAccountToken
 * reads it lazily (via process.env.FULL_ACCOUNT_JWT_SECRET) at sign time.
 */

import jwt from 'jsonwebtoken';
import { issueFullAccountToken, verifyFullAccountToken } from '../src/services/auth-token';

const TEST_SECRET = 'test-secret-for-auth-token-tests-only';

describe('auth-token — issueFullAccountToken / verifyFullAccountToken', () => {
  let originalSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.FULL_ACCOUNT_JWT_SECRET;
    process.env.FULL_ACCOUNT_JWT_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.FULL_ACCOUNT_JWT_SECRET;
    else process.env.FULL_ACCOUNT_JWT_SECRET = originalSecret;
  });

  it('round-trips a valid token', () => {
    const t = issueFullAccountToken('builder-abc', 'Alice@Example.com');
    const r = verifyFullAccountToken(t);
    expect(r).not.toBeNull();
    expect(r?.builder_id).toBe('builder-abc');
    expect(r?.email).toBe('alice@example.com'); // normalized to lowercase
  });

  it('uses HS256 (verify against an alternate algorithm fails)', () => {
    const t = issueFullAccountToken('builder-x', 'x@y.io');
    // Try to decode with the wrong algorithm allow-list — should fail.
    expect(() => jwt.verify(t, TEST_SECRET, { algorithms: ['HS512'] })).toThrow();
  });

  it('returns null on a tampered signature', () => {
    const t = issueFullAccountToken('builder-x', 'x@y.io');
    // Flip a char in the signature segment (last of three dot-separated parts).
    const parts = t.split('.');
    parts[2] = (parts[2] ?? '').slice(0, -1) + (parts[2]?.endsWith('A') ? 'B' : 'A');
    const tampered = parts.join('.');
    expect(verifyFullAccountToken(tampered)).toBeNull();
  });

  it('returns null on expired tokens', () => {
    // Issue a token that is already expired by signing with negative exp.
    const expired = jwt.sign(
      { builder_id: 'b', email: 'a@b.io' },
      TEST_SECRET,
      { algorithm: 'HS256', expiresIn: '-1s' },
    );
    expect(verifyFullAccountToken(expired)).toBeNull();
  });

  it('returns null on malformed inputs', () => {
    expect(verifyFullAccountToken('')).toBeNull();
    expect(verifyFullAccountToken('not-a-jwt')).toBeNull();
    expect(verifyFullAccountToken('a.b')).toBeNull();
    expect(verifyFullAccountToken('a.b.c.d')).toBeNull();
    expect(verifyFullAccountToken(undefined as any)).toBeNull();
    expect(verifyFullAccountToken(null as any)).toBeNull();
    expect(verifyFullAccountToken(12345 as any)).toBeNull();
  });

  it('returns null when verifying a token signed by a different secret', () => {
    const t = jwt.sign({ builder_id: 'b', email: 'a@b.io' }, 'a-different-secret', {
      algorithm: 'HS256',
      expiresIn: '7d',
    });
    expect(verifyFullAccountToken(t)).toBeNull();
  });

  it('issueFullAccountToken throws clearly when FULL_ACCOUNT_JWT_SECRET is unset', () => {
    delete process.env.FULL_ACCOUNT_JWT_SECRET;
    expect(() => issueFullAccountToken('b', 'a@b.io')).toThrow(/FULL_ACCOUNT_JWT_SECRET/);
  });

  it('verifyFullAccountToken returns null (does not throw) when secret is unset', () => {
    const t = issueFullAccountToken('b', 'a@b.io'); // signed with TEST_SECRET
    delete process.env.FULL_ACCOUNT_JWT_SECRET;
    expect(verifyFullAccountToken(t)).toBeNull();
  });

  it('encodes a 7-day expiry by default', () => {
    const t = issueFullAccountToken('b', 'a@b.io');
    const decoded = jwt.decode(t) as { exp: number; iat: number } | null;
    expect(decoded).not.toBeNull();
    const window = decoded!.exp - decoded!.iat;
    // 7 days in seconds.
    expect(window).toBe(7 * 24 * 60 * 60);
  });

  it('rejects a payload missing builder_id or email', () => {
    // Manually craft a JWT with the right secret but no builder_id.
    const bad1 = jwt.sign({ email: 'a@b.io' }, TEST_SECRET, { algorithm: 'HS256', expiresIn: '7d' });
    const bad2 = jwt.sign({ builder_id: 'b' }, TEST_SECRET, { algorithm: 'HS256', expiresIn: '7d' });
    expect(verifyFullAccountToken(bad1)).toBeNull();
    expect(verifyFullAccountToken(bad2)).toBeNull();
  });
});
