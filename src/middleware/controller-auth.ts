import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { db } from '../db';
import { validateAgentApiKey } from '../auth/api-keys';

const SECRET: string = process.env.CONTROLLER_QR_SECRET || 'controller-secret-key-1337-abc';

export interface SbtContext {
  tokenId?: string;
  wallet?: string;
  tier?: string;
  isMaster: boolean;
}

export function mintQrToken(role: 'viewer' | 'operator' | 'admin', durationMs: number = 3600 * 1000): string {
  const expiresAt = Date.now() + durationMs;
  const payload = JSON.stringify({ role, expiresAt });
  const base64Payload = Buffer.from(payload).toString('base64url');
  const hmac = crypto.createHmac('sha256', SECRET);
  hmac.update(base64Payload);
  const sig = hmac.digest('hex');
  return `${base64Payload}.${sig}`;
}

export function verifyQrToken(tokenStr: string): { role: 'viewer' | 'operator' | 'admin'; expiresAt: number } | null {
  try {
    const parts = tokenStr.split('.');
    if (parts.length !== 2) return null;
    const base64Payload = parts[0];
    const sig = parts[1];
    if (!base64Payload || !sig) return null;

    const hmac = crypto.createHmac('sha256', SECRET);
    hmac.update(base64Payload);
    const expectedSig = hmac.digest('hex');
    if (sig !== expectedSig) return null;

    const payloadStr = Buffer.from(base64Payload, 'base64url').toString('utf8');
    const payload = JSON.parse(payloadStr);
    if (Date.now() > payload.expiresAt) return null; // Expired
    return payload;
  } catch (e) {
    return null;
  }
}

export async function resolveSbt(req: Request): Promise<SbtContext | null> {
  const token = ((req.headers['x-sbt-token'] as string) || '').trim();
  const wallet = ((req.headers['x-sbt-wallet'] as string) || '').trim().toLowerCase();
  if (!token && !wallet) return null;

  const query = token
    ? db.from('human_sbt_registry').select('token_id, wallet_address, qualification_tier').eq('token_id', token).limit(1)
    : db.from('human_sbt_registry').select('token_id, wallet_address, qualification_tier').ilike('wallet_address', wallet).limit(1);

  const { data } = await query;
  const row = data?.[0];
  if (!row) return null;

  const master = (process.env.CONTROLLER_MASTER_SBT || '').trim();
  const isMaster =
    !!master &&
    (row.token_id === master || (row.wallet_address || '').toLowerCase() === master.toLowerCase());

  return { tokenId: row.token_id, wallet: row.wallet_address ?? undefined, tier: row.qualification_tier ?? undefined, isMaster };
}

export async function resolveControllerRole(req: Request): Promise<'viewer' | 'operator' | 'admin' | null> {
  // 1. Check for scoped QR token in Authorization header, x-controller-token header, or query param
  let tokenStr = '';
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string') {
    if (authHeader.startsWith('Bearer ')) {
      tokenStr = authHeader.substring(7).trim();
    } else {
      tokenStr = authHeader.trim();
    }
  }
  if (!tokenStr) {
    tokenStr = ((req.headers['x-controller-token'] as string) || '').trim();
  }
  if (!tokenStr && req.query.token) {
    tokenStr = String(req.query.token).trim();
  }

  if (tokenStr) {
    const verified = verifyQrToken(tokenStr);
    if (verified) {
      return verified.role;
    }
  }

  // 2. Check for API key (x-api-key header or Authorization header if not matching QR token)
  let apiKey = ((req.headers['x-api-key'] as string) || '').trim();
  if (!apiKey && authHeader && !authHeader.startsWith('Bearer ') && !authHeader.includes('.')) {
    apiKey = authHeader.trim();
  }
  if (!apiKey && authHeader && authHeader.startsWith('Bearer ')) {
    const candidate = authHeader.substring(7).trim();
    if (!candidate.includes('.')) { // Scoped QR tokens have a dot, API keys do not
      apiKey = candidate;
    }
  }

  if (apiKey) {
    const validated = await validateAgentApiKey(apiKey);
    if (validated) {
      if (validated.scopes.includes('admin') || apiKey === process.env.CONTROLLER_MASTER_KEY) {
        return 'admin';
      }
      if (validated.scopes.includes('operator')) {
        return 'operator';
      }
      return 'viewer';
    }
  }

  // 3. Check for SBT (x-sbt-token or x-sbt-wallet)
  try {
    const sbt = await resolveSbt(req);
    if (sbt) {
      if (sbt.isMaster || sbt.tier === 'institutional') {
        return 'admin';
      }
      if (sbt.tier === 'qualified_investor') {
        return 'operator';
      }
      return 'viewer';
    }
  } catch (e) {
    console.error('SBT lookup failed', e);
  }

  return null;
}

const roleHierarchy = {
  viewer: 1,
  operator: 2,
  admin: 3
};

export function requireRole(requiredRole: 'viewer' | 'operator' | 'admin') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const role = await resolveControllerRole(req);
    if (!role) {
      res.status(401).json({ error: 'Unauthorized: Valid SBT, API key, or scoped QR token required' });
      return;
    }

    if (roleHierarchy[role] < roleHierarchy[requiredRole]) {
      res.status(403).json({ error: `Forbidden: Requires at least ${requiredRole} permission (your role: ${role})` });
      return;
    }

    (req as any).controllerRole = role;

    // f2-authz check for controller routes when authenticated via API Key
    const dbAgentId = (req as any).dbAgentId;
    if (dbAgentId) {
      const targetAgentId = req.body?.agent_id || 
                            req.body?.buyer_agent_id || 
                            req.body?.requestor_agent_id || 
                            req.body?.provider_agent_id ||
                            req.body?.agent ||
                            req.query?.agent_id ||
                            req.query?.agent ||
                            req.query?.buyer_agent_id ||
                            req.query?.provider_agent_id;
      
      const targetAgentName = req.body?.agent_name || 
                              req.body?.agent_assigned || 
                              req.body?.assigned_to;

      let boundAgentName: string | undefined;
      try {
        const fromObj = db.from('repid_agents');
        if (fromObj && typeof fromObj.select === 'function') {
          const { data: agentData } = await fromObj.select('agent_name').eq('id', dbAgentId).maybeSingle();
          boundAgentName = agentData?.agent_name;
        }
      } catch (e) {
        console.warn('[controllerAuth] repid_agents lookup failed (possibly mocked DB):', e);
      }

      if (targetAgentId || targetAgentName) {
        if (targetAgentId && String(targetAgentId).trim().toLowerCase() !== String(dbAgentId).trim().toLowerCase()) {
          if (!boundAgentName || String(targetAgentId).trim().toLowerCase() !== boundAgentName.toLowerCase()) {
            res.status(403).json({ error: 'Forbidden: agent_id mismatch (API key is bound to a different agent identity)' });
            return;
          }
        }

        if (targetAgentName && boundAgentName && String(targetAgentName).trim().toLowerCase() !== boundAgentName.toLowerCase()) {
          if (String(targetAgentName).trim().toLowerCase() !== dbAgentId.toLowerCase()) {
            res.status(403).json({ error: 'Forbidden: agent_name mismatch (API key is bound to a different agent identity)' });
            return;
          }
        }
      }

      // Check for UUID or name in URL path parameters
      const pathParts = req.path.split('/');
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const pathUuid = pathParts.find(p => uuidRe.test(p));
      if (pathUuid && pathUuid.toLowerCase() !== dbAgentId.toLowerCase()) {
        res.status(403).json({ error: 'Forbidden: agent_id in path mismatch (API key is bound to a different agent identity)' });
        return;
      }

      const lastPart = pathParts[pathParts.length - 1];
      if (lastPart && lastPart.length > 0 && !uuidRe.test(lastPart) &&
          !['directives', 'token', 'agent-grid', 'activity-feed', 'hallucination-meter', 'squads', 'leads'].includes(lastPart.toLowerCase())) {
        if (boundAgentName && lastPart.toLowerCase() !== boundAgentName.toLowerCase()) {
          res.status(403).json({ error: 'Forbidden: agent identity in path mismatch (API key is bound to a different agent identity)' });
          return;
        }
      }
    }

    next();
  };
}

// Keep backwards compatibility with requireHumanSbt
export function requireHumanSbt(opts: { master?: boolean } = {}) {
  return requireRole(opts.master ? 'admin' : 'viewer');
}
