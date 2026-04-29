import {
  generateShareToken,
  verifyShareToken,
  parseShareTokenFromUrl,
  ShareIntent,
} from '../src/utils/share-token';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_SECRET = process.env.SHARE_TOKEN_SECRET;
const ORIGINAL_BASE = process.env.TRUSTREPID_BASE_URL;

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  // Force a known secret so we can validate signature stability
  process.env.SHARE_TOKEN_SECRET = 'unit-test-secret-1234567890';
  delete process.env.TRUSTREPID_BASE_URL;
});

afterAll(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_SECRET === undefined) delete process.env.SHARE_TOKEN_SECRET;
  else process.env.SHARE_TOKEN_SECRET = ORIGINAL_SECRET;
  if (ORIGINAL_BASE === undefined) delete process.env.TRUSTREPID_BASE_URL;
  else process.env.TRUSTREPID_BASE_URL = ORIGINAL_BASE;
});

describe('generateShareToken / verifyShareToken roundtrip', () => {
  const intents: ShareIntent[] = ['referral', 'challenge', 'demo_share'];

  intents.forEach((intent) => {
    it(`roundtrips for intent='${intent}'`, () => {
      const r = generateShareToken({ builderId: 'builder-abc', intent });
      expect(typeof r.token).toBe('string');
      expect(r.token.split('.').length).toBe(2);
      expect(r.signedUrl).toContain('?ts=');
      expect(r.signedUrl).toContain(r.token);
      expect(r.qrCodeData).toBe(r.signedUrl);
      expect(r.expiresAt).toBeGreaterThan(Date.now());

      const v = verifyShareToken(r.token);
      expect(v.valid).toBe(true);
      expect(v.error).toBeUndefined();
      expect(v.payload?.builderId).toBe('builder-abc');
      expect(v.payload?.intent).toBe(intent);
      expect(v.payload?.expiresAt).toBe(r.expiresAt);
      expect(typeof v.payload?.nonce).toBe('string');
      expect(v.payload?.nonce.length).toBe(16); // 8 bytes hex = 16 chars
    });
  });

  it('produces a different nonce on each generation', () => {
    const a = generateShareToken({ builderId: 'b1', intent: 'referral' });
    const b = generateShareToken({ builderId: 'b1', intent: 'referral' });
    const va = verifyShareToken(a.token);
    const vb = verifyShareToken(b.token);
    expect(va.payload?.nonce).not.toBe(vb.payload?.nonce);
  });

  it('uses the configured base URL', () => {
    process.env.TRUSTREPID_BASE_URL = 'https://example.test';
    const r = generateShareToken({ builderId: 'b1', intent: 'referral' });
    expect(r.signedUrl.startsWith('https://example.test/?ts=')).toBe(true);
    delete process.env.TRUSTREPID_BASE_URL;
  });

  it('strips trailing slash from base URL', () => {
    process.env.TRUSTREPID_BASE_URL = 'https://example.test/';
    const r = generateShareToken({ builderId: 'b1', intent: 'referral' });
    expect(r.signedUrl.startsWith('https://example.test/?ts=')).toBe(true);
    expect(r.signedUrl).not.toContain('//?ts=');
    delete process.env.TRUSTREPID_BASE_URL;
  });
});

describe('verifyShareToken — tampering', () => {
  it('rejects tampered payload with invalid_signature', () => {
    const r = generateShareToken({ builderId: 'b1', intent: 'referral' });
    const [encodedPayload, sig] = r.token.split('.');
    // Decode, mutate, re-encode
    const payloadJson = Buffer.from(
      encodedPayload!.replace(/-/g, '+').replace(/_/g, '/') +
        '='.repeat((4 - (encodedPayload!.length % 4)) % 4),
      'base64',
    ).toString('utf8');
    const obj = JSON.parse(payloadJson);
    obj.builderId = 'attacker';
    const tamperedPayload = Buffer.from(JSON.stringify(obj), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const tampered = `${tamperedPayload}.${sig}`;
    const v = verifyShareToken(tampered);
    expect(v.valid).toBe(false);
    expect(v.error).toBe('invalid_signature');
  });

  it('rejects tampered signature with invalid_signature', () => {
    const r = generateShareToken({ builderId: 'b1', intent: 'challenge' });
    const [encodedPayload, sig] = r.token.split('.');
    // Flip the last char of the signature; if it was 'A' make it 'B'
    const last = sig!.charAt(sig!.length - 1);
    const flipped = last === 'A' ? 'B' : 'A';
    const tamperedSig = sig!.slice(0, -1) + flipped;
    const v = verifyShareToken(`${encodedPayload}.${tamperedSig}`);
    expect(v.valid).toBe(false);
    expect(v.error).toBe('invalid_signature');
  });

  it('rejects token with single byte different in HMAC (timing-safe smoke)', () => {
    const r = generateShareToken({ builderId: 'b1', intent: 'demo_share' });
    const [enc, sig] = r.token.split('.');
    // Replace exactly one character mid-signature to ensure same length
    const idx = Math.floor(sig!.length / 2);
    const orig = sig!.charAt(idx);
    const next = orig === 'a' ? 'b' : 'a';
    const mutated = sig!.slice(0, idx) + next + sig!.slice(idx + 1);
    const v = verifyShareToken(`${enc}.${mutated}`);
    expect(v.valid).toBe(false);
    expect(v.error).toBe('invalid_signature');
  });
});

describe('verifyShareToken — malformed inputs', () => {
  it('rejects empty string with malformed', () => {
    expect(verifyShareToken('').error).toBe('malformed');
  });

  it('rejects token missing dot with malformed', () => {
    expect(verifyShareToken('justonepiece').error).toBe('malformed');
  });

  it('rejects token with empty signature with malformed', () => {
    expect(verifyShareToken('payload.').error).toBe('malformed');
  });

  it('rejects token with non-base64 payload', () => {
    expect(verifyShareToken('!@#$%.signature').error).toBe('malformed');
  });

  it('rejects token whose payload is valid base64 of garbage', () => {
    const garbagePayload = Buffer.from('not-json-at-all', 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyShareToken(`${garbagePayload}.deadbeef`).error).toBe('malformed');
  });

  it('rejects token whose payload is JSON but missing fields', () => {
    const badPayload = Buffer.from(JSON.stringify({ builderId: 'b1' }), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(verifyShareToken(`${badPayload}.deadbeef`).error).toBe('malformed');
  });
});

describe('verifyShareToken — expiry', () => {
  it('rejects token with 0-hour expiry as expired', () => {
    const r = generateShareToken({
      builderId: 'b1',
      intent: 'referral',
      expiresInHours: 0,
    });
    // Expiry is essentially "now"; allow a tiny wait so Date.now() > expiresAt
    const start = Date.now();
    while (Date.now() <= start + 2) {
      // tight spin; cap at ~3ms
    }
    const v = verifyShareToken(r.token);
    expect(v.valid).toBe(false);
    expect(v.error).toBe('expired');
  });

  it('accepts token with 100-year future expiry', () => {
    const r = generateShareToken({
      builderId: 'b1',
      intent: 'referral',
      expiresInHours: 24 * 365 * 100,
    });
    const v = verifyShareToken(r.token);
    expect(v.valid).toBe(true);
  });
});

describe('verifyShareToken — invalid_intent', () => {
  it('rejects token with non-canonical intent value', () => {
    // Build a token with a fake intent but a valid signature
    const fakePayload = {
      builderId: 'b1',
      intent: 'admin_takeover',
      expiresAt: Date.now() + 1000 * 60 * 60,
      nonce: 'abcdef0123456789',
    };
    // Re-implement a quick sign so we can attach the right signature
    const { createHmac } = require('crypto');
    const enc = Buffer.from(JSON.stringify(fakePayload), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const sig = createHmac('sha256', process.env.SHARE_TOKEN_SECRET as string)
      .update(enc)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const v = verifyShareToken(`${enc}.${sig}`);
    expect(v.valid).toBe(false);
    expect(v.error).toBe('invalid_intent');
  });
});

describe('parseShareTokenFromUrl', () => {
  it('returns null for empty string', () => {
    expect(parseShareTokenFromUrl('')).toBeNull();
  });

  it('returns null for non-URL string without ?ts=', () => {
    expect(parseShareTokenFromUrl('hello world')).toBeNull();
  });

  it('returns null for URL missing ?ts= param', () => {
    expect(parseShareTokenFromUrl('https://trustrepid.dev/')).toBeNull();
  });

  it('returns null for empty ?ts= value', () => {
    expect(parseShareTokenFromUrl('https://trustrepid.dev/?ts=')).toBeNull();
  });

  it('extracts ts from canonical generated URL', () => {
    const r = generateShareToken({ builderId: 'b1', intent: 'referral' });
    const extracted = parseShareTokenFromUrl(r.signedUrl);
    expect(extracted).toBe(r.token);
  });

  it('handles URL-encoded token', () => {
    const r = generateShareToken({ builderId: 'b1', intent: 'referral' });
    const encoded = `https://trustrepid.dev/?ts=${encodeURIComponent(r.token)}`;
    const extracted = parseShareTokenFromUrl(encoded);
    expect(extracted).toBe(r.token);
  });

  it('handles URL with hash fragment after token', () => {
    const r = generateShareToken({ builderId: 'b1', intent: 'referral' });
    const url = `https://trustrepid.dev/?ts=${r.token}#section-2`;
    const extracted = parseShareTokenFromUrl(url);
    expect(extracted).toBe(r.token);
  });

  it('handles non-URL string with ?ts= via regex fallback', () => {
    expect(parseShareTokenFromUrl('?ts=abc.def')).toBe('abc.def');
  });

  it('does not throw on malformed URL', () => {
    expect(() => parseShareTokenFromUrl('not://a:valid url')).not.toThrow();
  });
});

describe('edge cases', () => {
  it('handles very large builderId', () => {
    const big = 'b'.repeat(10_000);
    const r = generateShareToken({ builderId: big, intent: 'referral' });
    const v = verifyShareToken(r.token);
    expect(v.valid).toBe(true);
    expect(v.payload?.builderId).toBe(big);
  });

  it('default expiresInHours is 168 (1 week) +/- 1s', () => {
    const before = Date.now();
    const r = generateShareToken({ builderId: 'b1', intent: 'referral' });
    const expectedExpiry = before + 168 * 60 * 60 * 1000;
    expect(Math.abs(r.expiresAt - expectedExpiry)).toBeLessThan(1000);
  });

  it('signedUrl and qrCodeData are equal', () => {
    const r = generateShareToken({ builderId: 'b1', intent: 'demo_share' });
    expect(r.qrCodeData).toBe(r.signedUrl);
  });
});
