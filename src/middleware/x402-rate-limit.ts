import { Request } from 'express';
import rateLimit from 'express-rate-limit';

export const escrowRateLimitPerIP = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // max 10 escrow attempts per IP per minute
  message: { error: 'rate_limit_exceeded', retry_after_seconds: 60 },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request): string => {
    return req.ip || '127.0.0.1';
  },
  validate: false,
});

export const escrowRateLimitPerApiKey = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // max 30 escrow attempts per API key per minute
  keyGenerator: (req: Request): string => {
    return (req.headers['x-api-key'] as string) || (req.headers['authorization'] as string) || req.ip || 'unknown-ip';
  },
  message: { error: 'rate_limit_exceeded', retry_after_seconds: 60 },
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
});
