/**
 * HYP-8 — the registration dedup window survives a restart, and never blocks on Redis.
 *
 * The fake below models the one Redis behaviour the window depends on: `SET key v PX ms NX` answers
 * `OK` for an absent key and `null` for a present one. "Restart" = clearing the process-local Map
 * while the fake (the shared store) keeps its keys — which is exactly what a Railway redeploy does.
 */
import type Redis from 'ioredis';
import {
  checkAndRecordDedup,
  __resetLocalDedupForTests,
  DEDUP_STORE_TIMEOUT_MS,
  DEDUP_WINDOW_MS,
} from '../src/services/register-dedup';
import { enterpriseKeyMatches } from '../src/middleware/enterprise-key';

function fakeRedis(): { client: Redis; keys: Map<string, number>; calls: unknown[][] } {
  const keys = new Map<string, number>();
  const calls: unknown[][] = [];
  const client = {
    set: async (...args: unknown[]) => {
      calls.push(args);
      const [key, , mode, ms, nx] = args as [string, string, string, number, string];
      expect(mode).toBe('PX');
      expect(ms).toBe(DEDUP_WINDOW_MS);
      expect(nx).toBe('NX');
      if (keys.has(key)) return null;
      keys.set(key, ms);
      return 'OK';
    },
  } as unknown as Redis;
  return { client, keys, calls };
}

beforeEach(() => __resetLocalDedupForTests());

describe('register dedup — shared store (HYP-8)', () => {
  it('a duplicate is still a duplicate after a restart', async () => {
    const redis = fakeRedis();
    const opts = { cache: () => redis.client };
    expect(await checkAndRecordDedup('203.0.113.7', 'Alpha', opts)).toEqual({ duplicate: false, store: 'shared' });
    __resetLocalDedupForTests(); // the process restarted; Redis did not
    expect(await checkAndRecordDedup('203.0.113.7', 'Alpha', opts)).toEqual({ duplicate: true, store: 'shared' });
  });

  it('is case-insensitive on the name and scoped to the IP', async () => {
    const redis = fakeRedis();
    const opts = { cache: () => redis.client };
    await checkAndRecordDedup('203.0.113.7', 'Alpha', opts);
    expect((await checkAndRecordDedup('203.0.113.7', 'ALPHA', opts)).duplicate).toBe(true);
    expect((await checkAndRecordDedup('198.51.100.9', 'Alpha', opts)).duplicate).toBe(false);
    expect((await checkAndRecordDedup('203.0.113.7', 'Beta', opts)).duplicate).toBe(false);
  });

  it('stores a hash, never the IP or the name', async () => {
    const redis = fakeRedis();
    await checkAndRecordDedup('203.0.113.7', 'Alpha', { cache: () => redis.client });
    const [key] = [...redis.keys.keys()];
    expect(key).toMatch(/^reg-dedup:v1:[0-9a-f]{64}$/);
    expect(key).not.toContain('203.0.113.7');
    expect(key.toLowerCase()).not.toContain('alpha');
  });

  it('a key the shared store lost inside the window is still caught by this process', async () => {
    const redis = fakeRedis();
    const opts = { cache: () => redis.client };
    await checkAndRecordDedup('203.0.113.7', 'Alpha', opts);
    redis.keys.clear(); // eviction / flush
    expect(await checkAndRecordDedup('203.0.113.7', 'Alpha', opts)).toEqual({ duplicate: true, store: 'shared' });
  });
});

describe('register dedup — when Redis cannot answer, the process Map decides (never blocks)', () => {
  it('no REDIS_URL: process store, same behaviour as before', async () => {
    const opts = { cache: () => null };
    expect(await checkAndRecordDedup('203.0.113.7', 'Alpha', opts)).toEqual({ duplicate: false, store: 'process' });
    expect(await checkAndRecordDedup('203.0.113.7', 'Alpha', opts)).toEqual({ duplicate: true, store: 'process' });
  });

  it('a Redis error falls back rather than failing the registration', async () => {
    const client = { set: async () => { throw new Error('ECONNRESET'); } } as unknown as Redis;
    expect(await checkAndRecordDedup('203.0.113.7', 'Alpha', { cache: () => client })).toEqual({ duplicate: false, store: 'process' });
  });

  it('a getCache that throws falls back too', async () => {
    const cache = () => { throw new Error('ONLY_ATTESTATIONS_LEAVE refused REDIS_URL'); };
    expect(await checkAndRecordDedup('203.0.113.7', 'Alpha', { cache })).toEqual({ duplicate: false, store: 'process' });
  });

  it('a Redis that never answers is abandoned after the timeout', async () => {
    const client = { set: () => new Promise(() => undefined) } as unknown as Redis;
    const t0 = Date.now();
    const r = await checkAndRecordDedup('203.0.113.7', 'Alpha', { cache: () => client });
    const elapsed = Date.now() - t0;
    expect(r).toEqual({ duplicate: false, store: 'process' });
    expect(elapsed).toBeGreaterThanOrEqual(DEDUP_STORE_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(DEDUP_STORE_TIMEOUT_MS + 1000);
  });

  it('an entry older than the window no longer counts', async () => {
    let now = 1_000_000;
    const opts = { cache: () => null, now: () => now };
    await checkAndRecordDedup('203.0.113.7', 'Alpha', opts);
    now += DEDUP_WINDOW_MS + 1;
    expect((await checkAndRecordDedup('203.0.113.7', 'Alpha', opts)).duplicate).toBe(false);
  });
});

describe('enterpriseKeyMatches — an unset key exempts nobody', () => {
  it('nothing configured: no header, an empty header, or the string "undefined" never match', () => {
    expect(enterpriseKeyMatches(undefined, undefined)).toBe(false);
    expect(enterpriseKeyMatches('', undefined)).toBe(false);
    expect(enterpriseKeyMatches('undefined', undefined)).toBe(false);
    expect(enterpriseKeyMatches(undefined, '')).toBe(false);
    expect(enterpriseKeyMatches('', '   ')).toBe(false);
  });

  it('configured: only the exact key matches; arrays and other types never do', () => {
    expect(enterpriseKeyMatches('k-123', 'k-123')).toBe(true);
    expect(enterpriseKeyMatches(' k-123 ', 'k-123')).toBe(true);
    expect(enterpriseKeyMatches('k-124', 'k-123')).toBe(false);
    expect(enterpriseKeyMatches('k-12', 'k-123')).toBe(false);
    expect(enterpriseKeyMatches(undefined, 'k-123')).toBe(false);
    expect(enterpriseKeyMatches(['k-123'], 'k-123')).toBe(false);
  });
});
