import type { Request, Response, NextFunction, RequestHandler } from 'express';

export interface RateLimitOptions {
  maxRequests: number;
  windowMs: number;
  getBuilderId?: (req: Request) => string | undefined;
}

interface Bucket {
  count: number;
  resetAt: number;
}

interface RateLimiterHandle extends RequestHandler {
  _buckets: Map<string, Bucket>;
  _stopCleanup: () => void;
}

const DEFAULT_GET_BUILDER_ID = (req: Request): string | undefined => {
  const fromAuth = (req as unknown as { builderId?: unknown }).builderId;
  if (typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;
  const fromParams = req.params && (req.params as Record<string, unknown>).builderId;
  if (typeof fromParams === 'string' && fromParams.length > 0) return fromParams;
  const body = (req as unknown as { body?: Record<string, unknown> }).body;
  const fromBody = body && body['builder_id'];
  if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody;
  const fromHeader = req.headers['x-builder-id'];
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;
  return undefined;
};

const CLEANUP_INTERVAL_MS = 60_000;

export function rateLimitByBuilder(opts: RateLimitOptions): RateLimiterHandle {
  if (!opts || opts.maxRequests <= 0 || opts.windowMs <= 0) {
    throw new Error('rateLimitByBuilder: maxRequests and windowMs must be positive');
  }
  const getBuilderId = opts.getBuilderId ?? DEFAULT_GET_BUILDER_ID;
  const buckets = new Map<string, Bucket>();

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, CLEANUP_INTERVAL_MS);
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

  const handler: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const builderId = getBuilderId(req);
    if (!builderId) {
      // No builder identity → don't rate-limit this path. Auth middleware (if any)
      // is responsible for rejecting unauthenticated requests upstream.
      return next();
    }

    const now = Date.now();
    let bucket = buckets.get(builderId);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(builderId, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, opts.maxRequests - bucket.count);
    res.setHeader('X-RateLimit-Limit', String(opts.maxRequests));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > opts.maxRequests) {
      const retryAfterMs = Math.max(0, bucket.resetAt - now);
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      res.status(429).json({
        error: 'RATE_LIMITED',
        retry_after_ms: retryAfterMs,
      });
      return;
    }

    next();
  };

  const handle = handler as RateLimiterHandle;
  handle._buckets = buckets;
  handle._stopCleanup = () => clearInterval(cleanupTimer);
  return handle;
}
