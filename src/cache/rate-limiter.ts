/**
 * S-CACHE Phase 4 — persistent rate limiter (survives deploys, shared across instances).
 *
 * Fixed-window counter in Redis: key = rate:<id>:<window-index>, INCR with the window TTL. When
 * Redis is unavailable, `cacheIncr` returns 0 → we FAIL OPEN (allowed) rather than block real users
 * on an infra hiccup. (The in-process token bucket in src/middleware/rate-limit.ts remains the
 * always-on local cap; this adds a durable shared layer.)
 */
import { cacheIncr } from './dragonfly';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetIn: number;   // seconds until the window rolls
  count: number;
  backend: 'redis' | 'fail-open';
}

export async function checkRateLimit(
  identifier: string,
  limit = 10,
  windowSeconds = 86400,
): Promise<RateLimitResult> {
  const id = (identifier || 'unknown').replace(/\s+/g, '');
  const nowSec = Math.floor(Date.now() / 1000);
  const windowIndex = Math.floor(nowSec / windowSeconds);
  const key = `rate:${id}:${windowIndex}`;
  const count = await cacheIncr(key, windowSeconds);

  if (count === 0) {
    // Redis unavailable → fail open (don't block real users on an infra blip).
    return { allowed: true, remaining: limit, resetIn: windowSeconds - (nowSec % windowSeconds), count: 0, backend: 'fail-open' };
  }
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetIn: windowSeconds - (nowSec % windowSeconds),
    count,
    backend: 'redis',
  };
}
