/**
 * S-CACHE — per-IP rate-limit middleware backed by DragonflyDB (persistent, shared across instances).
 *
 * Wraps `checkRateLimit` (src/cache/rate-limiter.ts). Default 10 requests / 24h per IP — the public
 * "ask" budget (matches the TrustChat free-question allowance). Sets X-RateLimit-* headers; returns
 * 429 over the limit. FAILS OPEN when Redis is unavailable (the limiter returns allowed) so an infra
 * blip never blocks real users.
 *
 * NOTE: the user-facing `/chat` lives in trustchat-backend (which has no Redis today). This middleware
 * is applied here to repid-engine's public `/hal/evaluate` surface (trustchat-backend's server path is
 * `/hal/signals`, so this does NOT throttle the HAL pipeline). To rate-limit actual /chat users, add
 * Redis + the same pattern to trustchat-backend.
 */
import { Request, Response, NextFunction } from 'express';
import { checkRateLimit } from '../cache/rate-limiter';
import { hasValidEnvApiKey } from './env-api-key';

function clientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  const fromXff = Array.isArray(xff) ? xff[0] : (typeof xff === 'string' ? xff.split(',')[0] : undefined);
  return (fromXff || req.ip || req.socket?.remoteAddress || 'unknown').trim();
}

export function ipRateLimit(limit = 10, windowSeconds = 86400) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.method === 'OPTIONS') return next();
    // Authenticated callers bypass the public per-IP cap. The cap exists to fence
    // the ANONYMOUS demo budget; a request bearing a valid REPID_API_KEYS key is a
    // known, trusted caller, so it is not subject to the free per-IP allowance.
    // This is what lets an authenticated run of the trust-harness E2E demo actually
    // reach the HAL quorum instead of stalling on a 429. Only RELAXES the limit —
    // keyless traffic is unchanged — and only recognises env-allowlist keys.
    if (hasValidEnvApiKey(req.headers)) {
      res.setHeader('X-RateLimit-Bypass', 'api-key');
      return next();
    }
    try {
      const r = await checkRateLimit(`chat:${clientIp(req)}`, limit, windowSeconds);
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(r.remaining));
      res.setHeader('X-RateLimit-Reset', String(r.resetIn));
      if (!r.allowed) {
        res.status(429).json({
          error: 'RATE_LIMITED',
          message: 'Daily limit reached. Try again tomorrow.',
          remaining: r.remaining,
          resetIn: r.resetIn,
        });
        return;
      }
      return next();
    } catch {
      // Never block on limiter failure.
      return next();
    }
  };
}
