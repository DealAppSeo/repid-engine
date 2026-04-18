import { Request, Response, NextFunction } from 'express';
import { db } from '../db';

export const versioningMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  const providedVersion = req.headers['x-repid-version'] as string;
  const apiKeyObj = (req as any).apiKey;
  const key = apiKeyObj?.key || 'anonymous';

  const resolvedVersion = providedVersion || '2026-04-17';
  (req as any).apiVersion = resolvedVersion;

  // Ensure table exists on first run
  if (!(global as any)._api_key_versions_table_checked) {
    (global as any)._api_key_versions_table_checked = true;
    const { error: rpcError } = await db.rpc('run_sql', { sql: 'CREATE TABLE IF NOT EXISTS api_key_versions (api_key TEXT PRIMARY KEY, version TEXT NOT NULL, created_at TIMESTAMP DEFAULT NOW());' });
    if (rpcError) console.error(rpcError);
  }

  // Best effort log to Supabase logic
  const { error } = await db.from('api_key_versions').upsert({
    api_key: key,
    version: resolvedVersion,
    created_at: new Date().toISOString()
  }, { onConflict: 'api_key' });
  if (error) console.error(error);

  next();
};
