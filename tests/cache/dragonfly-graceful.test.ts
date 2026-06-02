/**
 * S-CACHE — the real dragonfly client must degrade to a safe no-op when REDIS_URL is unset, never
 * throwing (the cache is a pure accelerator). Runs with REDIS_URL deleted.
 */
import { getCache, cacheEnabled, cacheGet, cacheSet, cacheIncr, cacheDel, withJsonCache } from '../../src/cache/dragonfly';

describe('dragonfly graceful (no REDIS_URL)', () => {
  const prev = process.env.REDIS_URL;
  beforeAll(() => { delete process.env.REDIS_URL; });
  afterAll(() => { if (prev !== undefined) process.env.REDIS_URL = prev; });

  it('cacheEnabled() is false; getCache() returns null', () => {
    expect(cacheEnabled()).toBe(false);
    expect(getCache()).toBeNull();
  });
  it('primitives no-op without throwing', async () => {
    expect(await cacheGet('k')).toBeNull();
    await expect(cacheSet('k', 'v', 60)).resolves.toBeUndefined();
    expect(await cacheIncr('k', 60)).toBe(0);
    await expect(cacheDel('k')).resolves.toBeUndefined();
  });
  it('withJsonCache computes (uncached) when Redis is absent', async () => {
    let calls = 0;
    const r1 = await withJsonCache('lk', 60, async () => { calls++; return { n: 42 }; });
    expect(r1).toEqual({ value: { n: 42 }, cached: false });
    const r2 = await withJsonCache('lk', 60, async () => { calls++; return { n: 42 }; });
    expect(r2.cached).toBe(false);       // no store → always recompute
    expect(calls).toBe(2);
  });
});
