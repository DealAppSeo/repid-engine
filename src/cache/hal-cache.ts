/**
 * S-CACHE Phase 2 — HAL evaluation cache. Same (prompt, provider) within the TTL returns the cached
 * verdict instead of re-calling the LLM quorum. Keyed by sha256(prompt+provider). Graceful: a miss
 * (or no Redis) just means the normal path runs. Tracks hit/miss counters for /cache/stats.
 */
import crypto from 'crypto';
import { cacheGet, cacheSet, cacheIncr } from './dragonfly';

const HAL_CACHE_TTL = Number(process.env.HAL_CACHE_TTL ?? 3600); // 1h default

function hashPrompt(prompt: string, provider: string): string {
  return 'hal:' + crypto.createHash('sha256')
    .update(String(prompt).trim().toLowerCase() + ':' + String(provider))
    .digest('hex').substring(0, 24);
}

export async function getCachedHalResult(prompt: string, provider: string): Promise<any | null> {
  const cached = await cacheGet(hashPrompt(prompt, provider));
  if (!cached) { await cacheIncr('hal:stats:misses'); return null; }
  try {
    const result = JSON.parse(cached);
    result._cached = true;
    await cacheIncr('hal:stats:hits');
    return result;
  } catch { return null; }
}

export async function cacheHalResult(prompt: string, provider: string, result: any): Promise<void> {
  await cacheSet(hashPrompt(prompt, provider), JSON.stringify(result), HAL_CACHE_TTL);
}

export async function getHalCacheStats(): Promise<{ hits: number; misses: number; hit_rate: number }> {
  const hits = parseInt((await cacheGet('hal:stats:hits')) || '0', 10);
  const misses = parseInt((await cacheGet('hal:stats:misses')) || '0', 10);
  return { hits, misses, hit_rate: Math.round((hits / Math.max(hits + misses, 1)) * 1000) / 1000 };
}

export { hashPrompt as __hashPrompt };
