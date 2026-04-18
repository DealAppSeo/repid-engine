import { Request, Response, NextFunction } from 'express';
import { db } from '../db';

export const versioningMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const providedVersion = req.headers['x-repid-version'] as string;
  const apiKeyObj = (req as any).apiKey;
  const key = apiKeyObj?.key || 'anonymous';

  const resolvedVersion = providedVersion || '2026-04-17';
  (req as any).apiVersion = resolvedVersion;

  // Best effort log to Supabase logic
  db.from('api_key_versions').upsert({
    api_key: key,
    version: resolvedVersion,
    created_at: new Date().toISOString()
  }, { onConflict: 'api_key' }).then(() => {}).catch(() => {});

  next();
};
