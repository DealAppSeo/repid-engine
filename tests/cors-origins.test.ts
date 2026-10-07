/**
 * S-WIRE — CORS origin allow-list (trust*.dev pattern). Pure, runs in the main gate.
 */
import { isAllowedOrigin, TRUST_DEV_ORIGIN, allowedOrigins } from '../src/utils/cors-origins';

describe('isAllowedOrigin', () => {
  it('allows the explicit-list origins', () => {
    for (const o of allowedOrigins) expect(isAllowedOrigin(o)).toBe(true);
  });

  it('allows any trust*.dev apex + www', () => {
    for (const o of [
      'https://trustchat.dev', 'https://www.trustchat.dev',
      'https://trustrepid.dev', 'https://trustshell.dev',
      'https://trustmarket.dev', 'https://trustrails.dev', 'https://trust.dev',
    ]) expect(isAllowedOrigin(o)).toBe(true);
  });

  it('blocks look-alikes and non-trust origins', () => {
    for (const o of [
      'https://trustchat.dev.evil.com',   // ends in .com
      'http://trustchat.dev',             // not https
      'https://eviltrust.dev',            // no leading "trust"
      'https://nottrust.dev',
      'https://trustchat.com',            // not .dev
      'https://evil.com',
      'https://sub.trustchat.dev',        // a labelled subdomain is not apex/www
    ]) expect(isAllowedOrigin(o)).toBe(false);
  });

  it('repid.dev: exactly its two origins, never a pattern (Sean, 2026-10-07: "add that domain only")', () => {
    expect(isAllowedOrigin('https://www.repid.dev')).toBe(true);
    expect(isAllowedOrigin('https://repid.dev')).toBe(true);
    for (const o of [
      'http://www.repid.dev',            // not https
      'https://app.repid.dev',           // another subdomain is not listed
      'https://repid.dev.evil.com',
      'https://evilrepid.dev',
      'https://repid.com',
    ]) expect(isAllowedOrigin(o)).toBe(false);
  });

  it('the pattern is anchored at both ends', () => {
    expect(TRUST_DEV_ORIGIN.test('https://trustchat.dev')).toBe(true);
    expect(TRUST_DEV_ORIGIN.test('xhttps://trustchat.devx')).toBe(false);
  });
});
