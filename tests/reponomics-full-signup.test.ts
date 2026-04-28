/**
 * Reponomics — full-account (email + password) signup tests.
 *
 * Helper-only path (validateEmail, deriveAddressFromEmail, validatePassword)
 * is tested directly. createFullBuilder + verifyPassword exercised against
 * a stub db that records the insert. JWT token issue/verify tests live in
 * tests/auth-token.test.ts since the implementation moved to src/services/auth-token.ts.
 */

let inserted: any = null;
let existingByEmail: any = null;
let existingForVerify: any = null;

jest.mock('../src/db', () => {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    ilike: () => builder,
    insert: (row: any) => {
      inserted = row;
      return {
        select: () => ({
          single: async () => ({
            data: { id: '00000000-0000-0000-0000-bbbbbbbbbbbb' },
            error: null,
          }),
        }),
      };
    },
    maybeSingle: async () => {
      // Routed by which table+select shape the caller invoked. For our two
      // sites (existence-check vs verify-password lookup) we toggle via the
      // module-scoped variables above.
      if (existingByEmail !== undefined && existingByEmail !== null && !existingForVerify) {
        return { data: existingByEmail, error: null };
      }
      if (existingForVerify) {
        return { data: existingForVerify, error: null };
      }
      return { data: null, error: null };
    },
    single: async () => ({ data: null, error: null }),
  };
  return {
    db: {
      from: () => builder,
      rpc: async () => ({ data: { id: 1, current_entry_hash: 'mock' }, error: null }),
    },
  };
});

import {
  createFullBuilder,
  verifyPassword,
  deriveAddressFromEmail,
  validateEmail,
  validatePassword,
} from '../src/services/full-account-signup';

beforeAll(() => {
  // auth-token now requires FULL_ACCOUNT_JWT_SECRET to be set (no default fallback).
  process.env.FULL_ACCOUNT_JWT_SECRET ||= 'test-full-signup-secret';
});

beforeEach(() => {
  inserted = null;
  existingByEmail = null;
  existingForVerify = null;
});

describe('full-account-signup — validateEmail', () => {
  it('accepts standard emails', () => {
    expect(validateEmail('alice@example.com')).toBe(true);
    expect(validateEmail('a.b+c@sub.example.io')).toBe(true);
  });
  it('rejects malformed', () => {
    expect(validateEmail('')).toBe(false);
    expect(validateEmail('no-at')).toBe(false);
    expect(validateEmail('two@@example.com')).toBe(false);
    expect(validateEmail('a@b')).toBe(false);
  });
});

describe('full-account-signup — validatePassword', () => {
  it('requires ≥ 8 chars', () => {
    expect(validatePassword('short').ok).toBe(false);
    expect(validatePassword('longenough').ok).toBe(true);
  });
  it('rejects > 200 chars', () => {
    expect(validatePassword('x'.repeat(201)).ok).toBe(false);
  });
});

describe('full-account-signup — deriveAddressFromEmail', () => {
  it('is deterministic', () => {
    const a = deriveAddressFromEmail('alice@example.com');
    const b = deriveAddressFromEmail('alice@example.com');
    expect(a).toBe(b);
  });
  it('starts with the visible 0xEMAIL marker', () => {
    expect(deriveAddressFromEmail('any@example.com').startsWith('0xEMAIL')).toBe(true);
  });
  it('normalizes case', () => {
    const a = deriveAddressFromEmail('Alice@Example.com');
    const b = deriveAddressFromEmail('alice@example.com');
    expect(a).toBe(b);
  });
});

describe('full-account-signup — createFullBuilder', () => {
  it('rejects bad email', async () => {
    const r = await createFullBuilder({ email: 'not-an-email', password: 'longenough' });
    expect(r.ok).toBe(false);
  });

  it('rejects short password', async () => {
    const r = await createFullBuilder({ email: 'a@b.co', password: '123' });
    expect(r.ok).toBe(false);
  });

  it('rejects when email already exists', async () => {
    existingByEmail = { id: 'existing-uuid' };
    const r = await createFullBuilder({ email: 'taken@example.com', password: 'longenough' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/already/i);
  });

  it('creates with auth_method=email, earns_repid_rewards=true, current_repid=5000', async () => {
    const r = await createFullBuilder({ email: 'new@example.com', password: 'longenough' });
    expect(r.ok).toBe(true);
    expect(r.builder_id).toBeTruthy();
    expect(r.repid_rewards_eligible).toBe(true);
    // JWT shape: three dot-separated base64url segments.
    expect(r.login_token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(inserted).toBeTruthy();
    expect(inserted.auth_method).toBe('email');
    expect(inserted.earns_repid_rewards).toBe(true);
    expect(inserted.current_repid).toBe(5000);
    expect(inserted.password_hash).toBeTruthy();
    expect(inserted.password_hash).not.toBe('longenough');     // never store plaintext
  });
});

describe('full-account-signup — verifyPassword', () => {
  it('rejects unknown email', async () => {
    const r = await verifyPassword('missing@example.com', 'whatever');
    expect(r.ok).toBe(false);
  });
});

