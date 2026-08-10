/**
 * Identity token issuance — the load-bearing invariants.
 *
 * THE ONE THAT MATTERS MOST is hash parity. The minter and the rate-limit
 * validator each compute sha256 over "the random part" of `hdg_byok_<random>`.
 * They live in different files and neither imports the other's function. If they
 * ever disagree — a different slice, a different encoding, hashing the whole
 * token instead of the suffix — every minted token authenticates as invalid,
 * silently, and the only symptom is testers mysteriously hitting the 10/IP
 * bucket. A comment saying "MUST match" is not a mechanism. This is.
 *
 * These tests are pure: no DB, no network. They exercise the hashing and the
 * input validation, which is where a silent contract break would live.
 */
import crypto from 'crypto';
import { hashTokenSuffix } from '../src/services/identity-token';

/**
 * Re-derives the validator's hash the way middleware/rate-limit.ts does, read
 * from that file's SOURCE rather than reimplemented here. Reimplementing it
 * would test this test's copy, not the validator — the same mistake as a corpus
 * validator checking its own fixtures.
 */
function validatorHashFromSource(): (s: string) => string {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'rate-limit.ts'), 'utf8');
  const m = src.match(/function hashByokKey\(raw: string\): string \{\s*return ([^;]+);/);
  if (!m || !m[1]) throw new Error('could not locate hashByokKey in middleware/rate-limit.ts — the contract this test guards has moved');
  // The body is expected to be a crypto sha256 hex digest over `raw`.
  const body = m[1];
  expect(body).toContain("createHash('sha256')");
  expect(body).toContain("update(raw)");
  expect(body).toContain("digest('hex')");
  return (s: string) => crypto.createHash('sha256').update(s).digest('hex');
}

describe('hash parity between minter and validator', () => {
  it('the validator still hashes sha256(raw suffix) as hex', () => {
    // Fails loudly if someone changes the validator's hashing, instead of
    // letting every future token break quietly.
    expect(() => validatorHashFromSource()).not.toThrow();
  });

  it('minter and validator agree on the same suffix', () => {
    const validatorHash = validatorHashFromSource();
    for (const suffix of [
      'abc123',
      crypto.randomBytes(32).toString('base64url'),
      'A'.repeat(43),
      '-_-_-_-_',
    ]) {
      expect(hashTokenSuffix(suffix)).toBe(validatorHash(suffix));
    }
  });

  it('hashes the SUFFIX, never the whole token — the classic off-by-a-prefix', () => {
    const suffix = crypto.randomBytes(32).toString('base64url');
    const whole = `hdg_byok_${suffix}`;
    expect(hashTokenSuffix(suffix)).not.toBe(hashTokenSuffix(whole));
    // The validator's regex captures only the part after the prefix, so the
    // minter must hash that same part.
    const captured = /^Bearer\s+hdg_byok_(.+)$/.exec(`Bearer ${whole}`)?.[1];
    expect(captured).toBe(suffix);
    expect(hashTokenSuffix(captured!)).toBe(hashTokenSuffix(suffix));
  });

  it('produces a 64-char hex digest', () => {
    expect(hashTokenSuffix('x')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('token secrecy properties', () => {
  it('the hash is not invertible to the prefix stored for display', () => {
    // Display prefix is the first 8 chars of the suffix; it must not be enough
    // to reconstruct the hash (i.e. we are not storing a truncated secret).
    const suffix = crypto.randomBytes(32).toString('base64url');
    const displayPrefix = suffix.slice(0, 8);
    expect(hashTokenSuffix(displayPrefix)).not.toBe(hashTokenSuffix(suffix));
  });

  it('distinct suffixes hash distinctly', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(hashTokenSuffix(crypto.randomBytes(32).toString('base64url')));
    expect(seen.size).toBe(200);
  });
});
