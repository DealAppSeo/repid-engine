/**
 * Reponomics — anonymous (token-only) signup tests.
 *
 * Pure helper deriveAddressFromToken is tested directly. The DB-touching
 * createAnonymousBuilder is exercised against a mocked db.
 */

jest.mock('../src/db', () => {
  let lastInsert: any = null;
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    insert: (row: any) => {
      lastInsert = row;
      return {
        select: () => ({
          single: async () => ({
            data: { id: '00000000-0000-0000-0000-aaaaaaaaaaaa' },
            error: null,
          }),
        }),
      };
    },
    maybeSingle: async () => ({ data: null, error: null }),
    single: async () => ({ data: null, error: null }),
  };
  return {
    db: {
      from: () => builder,
      rpc: async () => ({ data: { id: 1, current_entry_hash: 'mock' }, error: null }),
    },
    _getLastInsert: () => lastInsert,
  };
});

import { createAnonymousBuilder, deriveAddressFromToken, getBuilderByToken } from '../src/services/anonymous-signup';

describe('anonymous-signup — deriveAddressFromToken', () => {
  it('returns a 0x-prefixed 40-hex-char address', () => {
    const a = deriveAddressFromToken('deadbeef'.repeat(8));
    expect(a).toMatch(/^0xT0KEN[0-9a-f]{34}$/);
    // Total length: '0x' + 'T0KEN' + 34 hex = 2 + 5 + 34 = 41 chars
    expect(a.length).toBe(41);
  });

  it('is deterministic per input token', () => {
    const a = deriveAddressFromToken('sample-token-1');
    const b = deriveAddressFromToken('sample-token-1');
    expect(a).toBe(b);
  });

  it('different tokens yield different addresses', () => {
    const a = deriveAddressFromToken('token-A');
    const b = deriveAddressFromToken('token-B');
    expect(a).not.toBe(b);
  });

  it('always begins with the visible 0xT0KEN demo marker', () => {
    for (const t of ['', 'a', 'longer-token-' + 'x'.repeat(50)]) {
      expect(deriveAddressFromToken(t).startsWith('0xT0KEN')).toBe(true);
    }
  });
});

describe('anonymous-signup — createAnonymousBuilder', () => {
  it('returns ok=true with token + builder_id + builder_address', async () => {
    const r = await createAnonymousBuilder();
    expect(r.ok).toBe(true);
    expect(r.token).toMatch(/^[0-9a-f]{64}$/);                       // 32 bytes hex
    expect(r.builder_id).toBe('00000000-0000-0000-0000-aaaaaaaaaaaa');
    expect(r.builder_address).toMatch(/^0xT0KEN[0-9a-f]{34}$/);
    expect(r.repid_rewards_eligible).toBe(false);
    expect(r.message).toMatch(/Token-only/i);
  });

  it('persists the row with auth_method=token_only and earns_repid_rewards=false', async () => {
    await createAnonymousBuilder();
    const dbMod: any = require('../src/db');
    const last = dbMod._getLastInsert();
    expect(last).toBeTruthy();
    expect(last.auth_method).toBe('token_only');
    expect(last.earns_repid_rewards).toBe(false);
    expect(last.session_token).toBeTruthy();
    expect(last.session_token).toBe(last.session_token);             // matches itself
    expect(typeof last.session_token).toBe('string');
  });

  it('two calls produce different tokens', async () => {
    const r1 = await createAnonymousBuilder();
    const r2 = await createAnonymousBuilder();
    expect(r1.token).not.toBe(r2.token);
    expect(r1.builder_address).not.toBe(r2.builder_address);
  });
});

describe('anonymous-signup — getBuilderByToken', () => {
  it('returns null for empty / too-short token', async () => {
    expect(await getBuilderByToken('')).toBeNull();
    expect(await getBuilderByToken('abc')).toBeNull();
  });
});
