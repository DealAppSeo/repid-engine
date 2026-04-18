import { Request, Response, NextFunction } from 'express';
import { db } from '../db';

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'GET' && (req.path.startsWith('/api/v1/repid/') || req.path.startsWith('/api/v1/erc8004/validate/'))) {
    return next();
  }

  const apiKey = (req.headers['authorization']?.replace('Bearer ', '') || req.headers['x-api-key']) as string;

  if (!apiKey) {
    return res.status(401).json({ error: 'Unauthorized: API key required' });
  }

  const rawKeys = process.env.REPID_API_KEYS || '';
  const keyList = rawKeys.split(',').map(s => s.trim()).filter(Boolean);
  
  let valid = false;
  let tier = 'free';

  for (const k of keyList) {
    // allow key:tier or just key format
    const [key, keyTier] = k.split(':');
    if (key === apiKey) {
      valid = true;
      if (keyTier) tier = keyTier;
      break;
    }
  }

  // Best effort log to Supabase
  const { error } = await db.from('trinity_agent_logs').insert({
    action: 'api_auth_attempt',
    metadata: {
      success: valid,
      tier,
      path: req.path,
      method: req.method,
      ip: req.ip
    }
  });
    if (error) console.error(error);

  if (!valid) {
    return res.status(403).json({ error: 'Forbidden: Invalid API key' });
  }

  (req as any).apiKey = { key: apiKey, tier };
  next();
};
