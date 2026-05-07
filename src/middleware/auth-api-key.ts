import { Request, Response, NextFunction } from 'express';
import { validateAgentApiKey } from '../auth/api-keys';

export function requireApiKey(scopes: string[] = []) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers['authorization'];
    const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';

    if (!token) {
      return res.status(401).json({ error: 'Missing API key' });
    }

    const validKey = await validateAgentApiKey(token);
    if (!validKey) {
      return res.status(401).json({ error: 'Invalid or revoked API key' });
    }

    if (scopes.length > 0) {
      const hasAllScopes = scopes.every(scope => validKey.scopes.includes(scope));
      if (!hasAllScopes) {
        return res.status(403).json({ error: 'Insufficient scopes' });
      }
    }

    // Attach agent_id and scopes to request object
    (req as any).agent_id = validKey.agent_id;
    (req as any).scopes = validKey.scopes;

    next();
  };
}
