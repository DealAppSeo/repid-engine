import { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL;
let redis: Redis | null = null;
if (redisUrl) {
  redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  redis.on('error', (err) => {
    console.warn('[RateLimit] Redis error:', err.message);
  });
}

export const checkRedisStatus = () => {
  if (!redis) return 'fallback (no REDIS_URL configured)';
  return redis.status === 'ready' ? 'connected' : `fallback (${redis.status})`;
};

export const rateLimitMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  if (!redis || redis.status !== 'ready') {
    return next(); // Fail open if no redis
  }

  const apiKeyObj = (req as any).apiKey;
  if (!apiKeyObj) return next();

  const { key, tier } = apiKeyObj;
  
  if (tier === 'enterprise') {
    return next();
  }

  const limit = tier === 'pro' ? 10000 : 100;
  const hourKey = `rate_limit:${key}:${new Date().getHours()}`;

  try {
    const current = await redis.incr(hourKey);
    if (current === 1) {
      await redis.expire(hourKey, 3600);
    }

    if (current > limit) {
      res.setHeader('Retry-After', '3600');
      return res.status(429).json({ error: 'Too Many Requests' });
    }
  } catch (err) {
    console.warn('[RateLimit] Exception, failing open:', err);
  }

  next();
};
