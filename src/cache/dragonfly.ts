/**
 * S-CACHE — DragonflyDB (Redis-compatible) cache layer.
 *
 * A GRACEFUL wrapper over the existing ioredis client (`src/clients/redis-client.ts`): every helper
 * degrades to a no-op / null when REDIS_URL is unset or Redis is unreachable, so the cache is a pure
 * accelerator — it can NEVER break a request. Reuses the single cached connection (no extra sockets).
 *
 * REDIS_URL is provisioned in Railway (DragonflyDB Cloud, `rediss://…`). Locally absent → no-op.
 */
import type Redis from 'ioredis';
import { getRedisClient } from '../clients/redis-client';

export function cacheEnabled(): boolean {
  return !!process.env.REDIS_URL;
}

/** The shared ioredis client, or null if REDIS_URL is unset / construction failed. Never throws. */
export function getCache(): Redis | null {
  if (!process.env.REDIS_URL) return null;
  try {
    return getRedisClient();
  } catch {
    return null;
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  try {
    const c = getCache();
    return c ? await c.get(key) : null;
  } catch { return null; }
}

export async function cacheSet(key: string, value: string, ttlSeconds?: number): Promise<void> {
  try {
    const c = getCache();
    if (!c) return;
    if (ttlSeconds && ttlSeconds > 0) await c.set(key, value, 'EX', ttlSeconds);
    else await c.set(key, value);
  } catch { /* never crash */ }
}

/** INCR with a TTL applied on first increment (so the window auto-expires). Returns 0 on failure. */
export async function cacheIncr(key: string, ttlSeconds?: number): Promise<number> {
  try {
    const c = getCache();
    if (!c) return 0;
    const val = await c.incr(key);
    if (ttlSeconds && ttlSeconds > 0 && val === 1) await c.expire(key, ttlSeconds);
    return val;
  } catch { return 0; }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    const c = getCache();
    if (c) await c.del(key);
  } catch { /* never crash */ }
}

/** Cache-aside JSON helper: return cached value (parsed) or compute, store (TTL), and return. */
export async function withJsonCache<T>(key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<{ value: T; cached: boolean }> {
  const hit = await cacheGet(key);
  if (hit) {
    try { return { value: JSON.parse(hit) as T, cached: true }; } catch { /* fall through */ }
  }
  const value = await compute();
  try { await cacheSet(key, JSON.stringify(value), ttlSeconds); } catch { /* ignore */ }
  return { value, cached: false };
}
