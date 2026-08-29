/**
 * Unit tests for the token-bucket rate limiter in src/middleware/rate-limit.ts
 *
 * Covers:
 *   - Token-bucket math (capacity, decrement, refuse-when-empty, refill)
 *   - Tier limit constants
 *   - Hash function determinism
 *
 * Integration tests (real Express server + supertest) are deferred — the
 * BYOK bypass branch requires the migration to be applied + a seeded
 * user_api_keys row + a real DB connection. The pure bucket math here
 * gives us confidence the algorithm is correct.
 */

import { bucketStore, __test, normalizeIpForKey } from '../src/middleware/rate-limit';

describe('BucketStore — token bucket math', () => {
  beforeEach(() => bucketStore.__reset());

  it('starts at full capacity', () => {
    const r = bucketStore.consume('k1', 10);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(9);
  });

  it('decrements one token per consume', () => {
    bucketStore.consume('k2', 10);
    bucketStore.consume('k2', 10);
    const r = bucketStore.consume('k2', 10);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(7);
  });

  it('refuses when exhausted', () => {
    for (let i = 0; i < 5; i++) bucketStore.consume('k3', 5);
    const r = bucketStore.consume('k3', 5);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('separate keys have independent buckets', () => {
    for (let i = 0; i < 5; i++) bucketStore.consume('a', 5);
    const ra = bucketStore.consume('a', 5);
    expect(ra.allowed).toBe(false);
    const rb = bucketStore.consume('b', 5);
    expect(rb.allowed).toBe(true);
  });

  it('refills proportionally over time', async () => {
    // Capacity 60/min = 1 per second. Drain to 0, wait ~1100ms, expect 1 token back.
    for (let i = 0; i < 60; i++) bucketStore.consume('refill', 60);
    expect(bucketStore.consume('refill', 60).allowed).toBe(false);
    await new Promise((res) => setTimeout(res, 1100));
    const r = bucketStore.consume('refill', 60);
    expect(r.allowed).toBe(true);
  });

  it('respects new capacity if route override changes limit', () => {
    // Initial 5 limit; drain to 2 remaining
    bucketStore.consume('over', 5);
    bucketStore.consume('over', 5);
    bucketStore.consume('over', 5);
    // Now same bucket consumed under tighter limit of 2 — should still allow once
    // because tokens=2 from prior, capacity adjusts down. Behavior: allow once more,
    // then refuse.
    const r1 = bucketStore.consume('over', 2);
    expect(r1.allowed).toBe(true);
    const r2 = bucketStore.consume('over', 2);
    expect(r2.allowed).toBe(true);
    const r3 = bucketStore.consume('over', 2);
    expect(r3.allowed).toBe(false);
  });
});

describe('Tier limits — constants are explicit', () => {
  it('declares all five canonical tiers + IP default', () => {
    const { TIER_LIMITS } = __test;
    expect(TIER_LIMITS.IP_DEFAULT).toBe(60);
    expect(TIER_LIMITS.PROBATIONARY).toBe(120);
    expect(TIER_LIMITS.EARNING).toBe(300);
    expect(TIER_LIMITS.ESTABLISHED).toBe(600);
    expect(TIER_LIMITS.AUTONOMOUS).toBe(1200);
    expect(TIER_LIMITS.VETERAN).toBe(1200);
  });

  it('limits ascend monotonically by tier', () => {
    const { TIER_LIMITS } = __test;
    expect(TIER_LIMITS.PROBATIONARY!).toBeGreaterThan(TIER_LIMITS.IP_DEFAULT!);
    expect(TIER_LIMITS.EARNING!).toBeGreaterThan(TIER_LIMITS.PROBATIONARY!);
    expect(TIER_LIMITS.ESTABLISHED!).toBeGreaterThan(TIER_LIMITS.EARNING!);
    expect(TIER_LIMITS.AUTONOMOUS!).toBeGreaterThan(TIER_LIMITS.ESTABLISHED!);
  });
});

describe('hashByokKey — deterministic SHA-256', () => {
  it('produces stable hex output', () => {
    const { hashByokKey } = __test;
    const a = hashByokKey('test-key-abc');
    const b = hashByokKey('test-key-abc');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('different inputs produce different hashes', () => {
    const { hashByokKey } = __test;
    expect(hashByokKey('a')).not.toBe(hashByokKey('b'));
  });
});

describe('normalizeIpForKey — IPv6 /64 bucketing (GMPD evasion guard)', () => {
  it('keys IPv4 as the whole address', () => {
    expect(normalizeIpForKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('strips IPv4-mapped IPv6 prefix', () => {
    expect(normalizeIpForKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('masks a full IPv6 address to its /64 prefix', () => {
    expect(normalizeIpForKey('2001:db8:abcd:1234:5678:9abc:def0:1')).toBe('2001:db8:abcd:1234::/64');
  });

  it('collapses an entire /64 to one bucket (rotating host bits cannot evade)', () => {
    const a = normalizeIpForKey('2001:db8:abcd:1234:1111:2222:3333:4444');
    const b = normalizeIpForKey('2001:db8:abcd:1234:ffff:ffff:ffff:ffff');
    expect(a).toBe(b);
    expect(a).toBe('2001:db8:abcd:1234::/64');
  });

  it('expands :: compression before taking the prefix', () => {
    expect(normalizeIpForKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(normalizeIpForKey('::1')).toBe('0:0:0:0::/64');
  });

  it('strips a zone id', () => {
    expect(normalizeIpForKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });

  it('passes through unknown', () => {
    expect(normalizeIpForKey('unknown')).toBe('unknown');
    expect(normalizeIpForKey('')).toBe('unknown');
  });
});

describe('Route overrides — match patterns', () => {
  it('halves recall route, triples registration.json', () => {
    const { ROUTE_OVERRIDES } = __test;
    const recall = ROUTE_OVERRIDES.find((r) => r.description === 'recall-semantic-search');
    expect(recall?.multiplier).toBe(0.5);
    expect('/api/v1/agents/f3ef0bf8-5cdc-4fad-bce8-5144f01dc271/recall').toMatch(recall!.match);

    const reg = ROUTE_OVERRIDES.find((r) => r.description === 'registration-json-cache');
    expect(reg?.multiplier).toBe(3);
    expect('/api/v1/agents/f3ef0bf8-5cdc-4fad-bce8-5144f01dc271/registration.json').toMatch(reg!.match);
  });
});

describe('anonymous account creation is not priced as a read', () => {
  /**
   * POST /api/v1/builder/token-signup is the public front door of the no-wallet flow.
   *
   * A red-team pass reported "no rate limit visible in the router or middleware for this
   * path". THAT IS WRONG, and the correction matters more than the finding: this
   * middleware is mounted globally on /api/v1 (src/index.ts), so the route always carried
   * IP_DEFAULT. Acting on the finding as stated would have meant building a second limiter
   * beside a working one.
   *
   * The real problem survives the correction and is subtler. Account creation carried the
   * SAME allowance as a cache-friendly GET — 60/min/IP, roughly 86,000 durable `builders`
   * rows per day from one address. Each row is persistent state that shows up in profile
   * reads and demo flows, so the generic read budget was simply the wrong unit.
   */
  const { ROUTE_OVERRIDES } = __test;
  const rule = () => ROUTE_OVERRIDES.find((r) => r.description === 'anonymous-account-creation');

  it('the signup route has its own, tighter budget', () => {
    expect(rule()).toBeDefined();
    expect(rule()!.multiplier).toBe(0.1);
    expect('/api/v1/builder/token-signup').toMatch(rule()!.match);
  });

  it('it is TIGHTER than the default, which is the entire point', () => {
    // A multiplier >= 1 here would be the override existing and buying nothing — the shape
    // of fix that looks applied and changes no behaviour.
    expect(rule()!.multiplier).toBeLessThan(1);
  });

  it('60/min becomes 6/min — enough for a shared NAT, not for bulk minting', () => {
    // Mirrors getRouteOverride's arithmetic. Not tighter on purpose: an office or
    // conference IP can produce several genuine signups in a minute, and a limit that
    // breaks those is one someone raises back out during an incident.
    expect(Math.max(1, Math.floor(60 * rule()!.multiplier))).toBe(6);
  });

  it('FAILABILITY: the pattern is anchored and does not leak onto neighbours', () => {
    // Without anchors this would also throttle every /builder/* read, which would be a
    // worse bug than the one being fixed.
    for (const p of [
      '/api/v1/builder/0xT0KENabc',
      '/api/v1/builder/token-signup/extra',
      '/api/v1/builders/token-signup',
      '/api/v1/agents/x/recall',
    ]) {
      expect(p).not.toMatch(rule()!.match);
    }
  });

  it('the other overrides are untouched', () => {
    expect(ROUTE_OVERRIDES.find((r) => r.description === 'recall-semantic-search')?.multiplier).toBe(0.5);
    expect(ROUTE_OVERRIDES.find((r) => r.description === 'registration-json-cache')?.multiplier).toBe(3);
  });
});
