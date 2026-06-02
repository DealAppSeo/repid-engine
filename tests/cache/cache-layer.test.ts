/**
 * S-CACHE — cache layer logic. The Redis primitives (dragonfly) are mocked with an in-memory store
 * so the module logic (HAL cache, rate limiter, verification consensus, provider health) is exercised
 * deterministically without a live Redis.
 */

// In-memory mock of the dragonfly primitives.
const store = new Map<string, string>();
jest.mock('../../src/cache/dragonfly', () => ({
  cacheEnabled: () => true,
  getCache: () => null,
  cacheGet: async (k: string) => (store.has(k) ? store.get(k)! : null),
  cacheSet: async (k: string, v: string) => { store.set(k, v); },
  cacheIncr: async (k: string) => { const n = (parseInt(store.get(k) || '0', 10) || 0) + 1; store.set(k, String(n)); return n; },
  cacheDel: async (k: string) => { store.delete(k); },
}));

import { getCachedHalResult, cacheHalResult, getHalCacheStats, __hashPrompt } from '../../src/cache/hal-cache';
import { checkRateLimit } from '../../src/cache/rate-limiter';
import { getCachedVerification, recordVerification } from '../../src/cache/verification-cache';
import { recordProviderCall, getProviderHealth } from '../../src/cache/provider-health';

beforeEach(() => store.clear());

describe('hal-cache', () => {
  it('hashPrompt is deterministic; different providers → different keys', () => {
    expect(__hashPrompt('Hello', 'groq')).toBe(__hashPrompt('hello', 'groq')); // case/space-insensitive
    expect(__hashPrompt('Hello', 'groq')).not.toBe(__hashPrompt('Hello', 'cerebras'));
  });
  it('miss → null then hit after caching', async () => {
    expect(await getCachedHalResult('what is 2+2', 'groq')).toBeNull();
    await cacheHalResult('what is 2+2', 'groq', { hal_score: 0.1, verdict: 'clean' });
    const hit = await getCachedHalResult('what is 2+2', 'groq');
    expect(hit).toMatchObject({ hal_score: 0.1, _cached: true });
  });
  it('tracks hit/miss stats', async () => {
    await getCachedHalResult('x', 'g');           // miss
    await cacheHalResult('x', 'g', { ok: 1 });
    await getCachedHalResult('x', 'g');           // hit
    const s = await getHalCacheStats();
    expect(s.hits).toBe(1); expect(s.misses).toBe(1); expect(s.hit_rate).toBeCloseTo(0.5, 3);
  });
});

describe('rate-limiter', () => {
  it('allows under the limit, blocks over it', async () => {
    const id = 'ip-1.2.3.4';
    let last;
    for (let i = 0; i < 3; i++) last = await checkRateLimit(id, 3, 86400);
    expect(last!.allowed).toBe(true);
    expect(last!.remaining).toBe(0);
    const over = await checkRateLimit(id, 3, 86400);
    expect(over.allowed).toBe(false);
    expect(over.backend).toBe('redis');
  });
});

describe('verification-cache', () => {
  it('caches only after 3 consistent high-confidence verdicts', async () => {
    const claim = 'the earth is round';
    expect(await getCachedVerification(claim)).toBeNull();
    await recordVerification(claim, 'TRUE', 0.9);
    await recordVerification(claim, 'TRUE', 0.9);
    expect(await getCachedVerification(claim)).toBeNull(); // only 2
    await recordVerification(claim, 'TRUE', 0.9);
    const hit = await getCachedVerification(claim);
    expect(hit).toMatchObject({ verdict: 'TRUE', cached: true, count: 3 });
  });
  it('a conflicting verdict resets consensus', async () => {
    const claim = 'disputed';
    for (let i = 0; i < 3; i++) await recordVerification(claim, 'TRUE', 0.9);
    await recordVerification(claim, 'FALSE', 0.9); // conflict → reset to count 1
    expect(await getCachedVerification(claim)).toBeNull();
  });
});

describe('provider-health', () => {
  it('records and computes success rate + health', async () => {
    for (let i = 0; i < 8; i++) await recordProviderCall('groq', true);
    for (let i = 0; i < 2; i++) await recordProviderCall('groq', false);
    const h = await getProviderHealth('groq');
    expect(h.calls).toBe(10); expect(h.success).toBe(8); expect(h.fail).toBe(2);
    expect(h.success_rate).toBeCloseTo(0.8, 3); expect(h.healthy).toBe(true);
  });
  it('marks unhealthy below 0.7 success with enough calls', async () => {
    for (let i = 0; i < 3; i++) await recordProviderCall('badprov', true);
    for (let i = 0; i < 7; i++) await recordProviderCall('badprov', false);
    expect((await getProviderHealth('badprov')).healthy).toBe(false);
  });
  it('healthy when too few calls to judge', async () => {
    await recordProviderCall('newprov', false);
    expect((await getProviderHealth('newprov')).healthy).toBe(true);
  });
});
