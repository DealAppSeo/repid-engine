/**
 * Full-account auth middleware.
 *
 * Decodes a login_token from `Authorization: Bearer <token>` and attaches
 * { builder_id, email } to req.fullAccountBuilder. If the token is missing
 * or invalid, returns 401.
 *
 * Use as a per-route middleware (NOT mounted globally) so the surrounding
 * authMiddleware (REPID API key) is bypassed for full-account routes.
 */

import { Request, Response, NextFunction } from 'express';
import { verifyLoginToken } from '../services/full-account-token';

export interface FullAccountContext {
  builder_id: string;
  email: string;
}

export function requireFullAccount(req: Request, res: Response, next: NextFunction): void {
  const header = (req.headers['authorization'] as string | undefined) ?? '';
  if (!header.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({ error: 'login_token required (Authorization: Bearer <token>)' });
    return;
  }
  const token = header.slice(7).trim();
  const r = verifyLoginToken(token);
  if (!r.ok || !r.payload) {
    res.status(401).json({ error: r.error ?? 'invalid login_token' });
    return;
  }
  (req as any).fullAccountBuilder = {
    builder_id: r.payload.builder_id,
    email: r.payload.email,
  } as FullAccountContext;
  next();
}

export function getFullAccountContext(req: Request): FullAccountContext | null {
  return ((req as any).fullAccountBuilder as FullAccountContext | undefined) ?? null;
}
