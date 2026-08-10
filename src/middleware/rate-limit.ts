/**
 * Token-bucket rate limiter for /api/v1/*.
 *
 * Identification order (first match wins):
 *   1. Authorization: Bearer hdg_byok_<key>
 *      → SHA-256 the suffix, lookup user_api_keys.key_hash → BYPASS (unmetered)
 *   2. X-HYPERDAG-REPID-ATTESTATION header
 *      → decode (Gemini's lane). If present and `agent_id` resolvable,
 *        use the agent's tier-based bucket
 *   3. Otherwise → IP-based bucket
 *
 * Tiers (per minute):
 *   NO-IDENTITY (IP):                 60
 *   PROBATIONARY agent:              120
 *   EARNING agent:                   300
 *   ESTABLISHED agent:               600
 *   AUTONOMOUS / VETERAN agent:     1200
 *
 * In-memory Map storage with periodic cleanup. Redis-ready (swap the
 * BucketStore implementation later without changing call sites).
 *
 * NOTE on coexistence with existing route limiters:
 *   `src/index.ts` already mounts `registrationLimiter`, `cardLimiter`,
 *   `externalScoreLimiter`, `scoreLimiter` via express-rate-limit on
 *   specific routes. THIS middleware is GLOBAL (applies to all
 *   /api/v1/*) and uses a different bucket key namespace (`ip:`, `agent:`,
 *   `byok:`) so it does NOT double-count with the per-route ones.
 *   Treat the per-route ones as additional stricter caps.
 */

import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import { db } from '../db';
import { getRedisClient } from '../clients/redis-client';

// ────────────────────────────────────────────────────────────────
// Bucket math
// ────────────────────────────────────────────────────────────────

interface BucketState {
  tokens: number;
  lastRefillMs: number;
  capacity: number;
  refillPerMs: number;
}

const WINDOW_MS = 60_000;

const TIER_LIMITS: Record<string, number> = {
  IP_DEFAULT: 60,
  PROBATIONARY: 120,
  EARNING: 300,
  ESTABLISHED: 600,
  AUTONOMOUS: 1200,
  VETERAN: 1200,
};

class BucketStore {
  private map = new Map<string, BucketState>();
  private lastSweepMs = Date.now();

  consume(key: string, limit: number): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const now = Date.now();
    const refillPerMs = limit / WINDOW_MS;

    // Periodic cleanup (every 2 windows)
    if (now - this.lastSweepMs > 2 * WINDOW_MS) this.sweep(now);

    let b = this.map.get(key);
    if (!b) {
      b = { tokens: limit, lastRefillMs: now, capacity: limit, refillPerMs };
      this.map.set(key, b);
    }

    // Adjust capacity if route override changed limit between calls
    if (b.capacity !== limit) {
      b.capacity = limit;
      b.refillPerMs = refillPerMs;
    }

    // Refill
    const elapsed = now - b.lastRefillMs;
    if (elapsed > 0) {
      b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerMs);
      b.lastRefillMs = now;
    }

    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, remaining: Math.floor(b.tokens), retryAfterSec: 0 };
    }

    // Compute seconds until 1 token regenerates
    const msUntilOne = (1 - b.tokens) / b.refillPerMs;
    return { allowed: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil(msUntilOne / 1000)) };
  }

  private sweep(now: number) {
    for (const [k, b] of this.map) {
      if (now - b.lastRefillMs > 2 * WINDOW_MS) this.map.delete(k);
    }
    this.lastSweepMs = now;
  }

  /** Test hook — clear all buckets */
  __reset() {
    this.map.clear();
    this.lastSweepMs = Date.now();
  }
}

export const bucketStore = new BucketStore();

/**
 * Atomic token bucket rate limiter using Redis Lua script.
 * Falls back to local in-memory BucketStore if Redis is unavailable.
 */
async function consumeRedis(key: string, limit: number): Promise<{ allowed: boolean; remaining: number; retryAfterSec: number }> {
  try {
    const redis = getRedisClient();
    const now = Date.now();
    
    const luaScript = `
      local key = KEYS[1]
      local capacity = tonumber(ARGV[1])
      local now = tonumber(ARGV[2])
      local refill_per_ms = capacity / 60000.0
      
      local current = redis.call('HMGET', key, 'tokens', 'last_refill')
      local tokens = tonumber(current[1]) or capacity
      local last_refill = tonumber(current[2]) or now
      
      local elapsed = now - last_refill
      local new_tokens = tokens
      if elapsed > 0 then
        new_tokens = math.min(capacity, tokens + (elapsed * refill_per_ms))
      end
      
      local allowed = 0
      local remaining = 0
      local retry_after_sec = 0
      
      if new_tokens >= 1 then
        allowed = 1
        new_tokens = new_tokens - 1
        remaining = math.floor(new_tokens)
        redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', now)
        redis.call('EXPIRE', key, 300)
      else
        allowed = 0
        remaining = 0
        local ms_until_one = (1 - new_tokens) / refill_per_ms
        retry_after_sec = math.max(1, math.ceil(ms_until_one / 1000))
        redis.call('HMSET', key, 'tokens', new_tokens, 'last_refill', now)
        redis.call('EXPIRE', key, 300)
      end
      
      return {allowed, remaining, retry_after_sec}
    `;
    
    const result = await redis.eval(
      luaScript,
      1,
      key,
      limit.toString(),
      now.toString()
    ) as [number, number, number];
    
    return {
      allowed: result[0] === 1,
      remaining: result[1],
      retryAfterSec: result[2],
    };
  } catch (err: any) {
    console.warn('[REDIS] Rate limit check failed, falling back to memory/fail-open:', err.message);
    try {
      return bucketStore.consume(key, limit);
    } catch {
      return { allowed: true, remaining: limit, retryAfterSec: 0 };
    }
  }
}

// ────────────────────────────────────────────────────────────────
// Identity resolution
// ────────────────────────────────────────────────────────────────

interface Identity {
  kind: 'byok' | 'agent' | 'ip';
  key: string;        // bucket key (full namespaced)
  limit: number;
  bypass: boolean;
  agent_id?: string;
  tier?: string;
  byok_key_id?: string;
}

/**
 * Hash the BYOK key suffix using SHA-256. The key format is
 * `hdg_byok_<random>`; we hash the random part for lookup.
 */
function hashByokKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Cache BYOK validations briefly so a burst of requests from the same
 * customer doesn't slam the DB. 60s TTL.
 */
const byokCache = new Map<string, { valid: boolean; key_id: string | null; cachedAtMs: number }>();
const BYOK_CACHE_TTL_MS = 60_000;

async function checkByok(rawSuffix: string): Promise<{ valid: boolean; key_id: string | null }> {
  const hash = hashByokKey(rawSuffix);
  const cached = byokCache.get(hash);
  const now = Date.now();
  if (cached && now - cached.cachedAtMs < BYOK_CACHE_TTL_MS) {
    return { valid: cached.valid, key_id: cached.key_id };
  }
  try {
    // Reads `hdg_identity_tokens`, NOT `user_api_keys`.
    //
    // This lookup previously targeted user_api_keys, whose NOT NULL
    // provider_name / encrypted_api_key columns exist to hold CUSTODIED
    // THIRD-PARTY SECRETS. An hdg_byok_* token is a HyperDAG-issued identity and
    // carries no secret of the user's, so it could never legally be inserted
    // there without fabricating a provider name and an encrypted key. The result
    // was a validator reading a table that could not hold what it searched for,
    // and no issuance path anywhere — the bypass branch was unreachable in
    // practice. user_api_keys was empty (0 rows) when this moved, so nothing
    // depended on the old target.
    const { data, error } = await db
      .from('hdg_identity_tokens')
      .select('id, status')
      .eq('key_hash', hash)
      .eq('status', 'active')
      .maybeSingle();
    if (error) {
      // Surface as not-bypassed (fall back to IP). Don't fail open.
      console.warn('[rate-limit] BYOK lookup error:', error.message);
      byokCache.set(hash, { valid: false, key_id: null, cachedAtMs: now });
      return { valid: false, key_id: null };
    }
    const valid = !!data;
    byokCache.set(hash, { valid, key_id: data?.id ?? null, cachedAtMs: now });
    return { valid, key_id: data?.id ?? null };
  } catch (e: any) {
    console.warn('[rate-limit] BYOK lookup crash:', e?.message ?? e);
    return { valid: false, key_id: null };
  }
}

function getClientIp(req: Request): string {
  // app.set('trust proxy', 1) is already configured in src/index.ts so req.ip
  // reads the leftmost X-Forwarded-For. Fall back to socket if undefined.
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * Normalize an IP for use as a rate-limit bucket key.
 *
 * IPv4 is keyed as-is. IPv6 is masked to its /64 prefix (the first four hextets) —
 * a single end user is routinely allocated a whole /64, so keying on the full /128
 * lets an attacker rotate addresses within their own subnet for a fresh bucket each
 * request (unbounded evasion). This mirrors express-rate-limit's `ipKeyGenerator`,
 * which the per-route limiters already use; this brings the tiered middleware in line.
 */
export function normalizeIpForKey(ip: string): string {
  if (!ip || ip === 'unknown') return 'unknown';
  // Strip IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 → 1.2.3.4) and zone id (%eth0).
  let v = ip.replace(/^::ffff:/i, '').split('%')[0] ?? ip;
  if (!v.includes(':')) return v; // IPv4 — key whole address
  // IPv6 → /64. Expand a single :: so we can take the first four groups deterministically.
  const dbl = v.indexOf('::');
  let groups: string[];
  if (dbl !== -1) {
    const head = v.slice(0, dbl).split(':').filter(Boolean);
    const tail = v.slice(dbl + 2).split(':').filter(Boolean);
    const fill = Array(Math.max(0, 8 - head.length - tail.length)).fill('0');
    groups = [...head, ...fill, ...tail];
  } else {
    groups = v.split(':');
  }
  return groups.slice(0, 4).map(g => g || '0').join(':') + '::/64';
}

async function resolveIdentity(req: Request, routeOverride: number | null): Promise<Identity> {
  // 1. BYOK
  const auth = (req.headers['authorization'] as string | undefined) ?? '';
  const m = /^Bearer\s+hdg_byok_(.+)$/.exec(auth);
  const byokSuffix = m?.[1];
  if (byokSuffix) {
    const { valid, key_id } = await checkByok(byokSuffix);
    if (valid) {
      return {
        kind: 'byok',
        key: `byok:${key_id ?? hashByokKey(byokSuffix)}`,
        limit: Number.POSITIVE_INFINITY,
        bypass: true,
        byok_key_id: key_id ?? undefined,
      };
    }
    // Invalid BYOK keys fall through to IP (don't reward bad keys with agent tiers).
  }

  // 2. RepID attestation (Gemini's lane — we just read agent_id if pre-populated)
  // Gemini's middleware (when shipped) attaches (req as any).repidAttestation = { agent_id, tier }.
  // Until then, this branch is inactive and IP-bucket applies.
  const att = (req as any).repidAttestation as { agent_id?: string; tier?: string } | undefined;
  if (att?.agent_id && att.tier) {
    const tierUp = att.tier.toUpperCase();
    const limit = routeOverride ?? (TIER_LIMITS[tierUp] ?? TIER_LIMITS.PROBATIONARY!);
    return {
      kind: 'agent',
      key: `agent:${att.agent_id}`,
      limit,
      bypass: false,
      agent_id: att.agent_id,
      tier: tierUp,
    };
  }

  // 3. IP fallback — key on the /64 prefix for IPv6 so a single subnet can't evade
  // the limit by rotating addresses (see normalizeIpForKey).
  const ip = normalizeIpForKey(getClientIp(req));
  const limit = routeOverride ?? TIER_LIMITS.IP_DEFAULT!;
  return { kind: 'ip', key: `ip:${ip}`, limit, bypass: false };
}

// ────────────────────────────────────────────────────────────────
// Route overrides (per-path tightening / loosening)
// ────────────────────────────────────────────────────────────────

interface RouteOverride {
  match: RegExp;
  multiplier: number; // applied to tier limit (e.g. 0.5 = half, 3 = triple)
  description: string;
}

const ROUTE_OVERRIDES: RouteOverride[] = [
  // Semantic search is expensive — half the limit
  { match: /^\/api\/v1\/agents\/[^/]+\/recall$/, multiplier: 0.5, description: 'recall-semantic-search' },
  // Public registration.json cache-friendly — triple
  { match: /^\/api\/v1\/agents\/[^/]+\/registration\.json$/, multiplier: 3, description: 'registration-json-cache' },
];

function getRouteOverride(reqPath: string, baseLimit: number): number | null {
  for (const r of ROUTE_OVERRIDES) {
    if (r.match.test(reqPath)) return Math.max(1, Math.floor(baseLimit * r.multiplier));
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// Public middleware
// ────────────────────────────────────────────────────────────────

export function rateLimitMiddleware() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method === 'OPTIONS') return next();
    // Only gate /api/v1/* — leave health, /, telegram-webhook etc. alone
    if (!req.path.startsWith('/api/v1')) return next();

    // Probe route override first so identity resolution uses the right limit
    const baseLimitForRoute = (await resolveIdentity(req, null)).limit;
    const routeOverride = getRouteOverride(req.path, baseLimitForRoute);
    const id = await resolveIdentity(req, routeOverride);

    if (id.bypass) {
      // BYOK fast path — no counters, no headers cluttered
      (req as any).rateLimit = { bucket: 'byok', bypass: true };
      return next();
    }

    const r = process.env.RATE_LIMIT_BACKEND === 'redis'
      ? await consumeRedis(id.key, id.limit)
      : bucketStore.consume(id.key, id.limit);
    res.setHeader('X-RateLimit-Limit', String(id.limit));
    res.setHeader('X-RateLimit-Remaining', String(r.remaining));
    res.setHeader('X-RateLimit-Bucket', id.kind);

    if (!r.allowed) {
      res.setHeader('Retry-After', String(r.retryAfterSec));
      res.status(429).json({
        error: 'rate_limited',
        bucket: id.kind,
        limit: id.limit,
        retry_after_seconds: r.retryAfterSec,
      });
      return;
    }

    (req as any).rateLimit = { bucket: id.kind, key: id.key, remaining: r.remaining, limit: id.limit };
    next();
  };
}

// Exported for tests
export const __test = { TIER_LIMITS, hashByokKey, ROUTE_OVERRIDES };
