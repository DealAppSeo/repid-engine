import { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { validateAgentApiKey } from '../auth/api-keys';
import { logAgentEvent } from '../engine/agent-log';

export const authMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'OPTIONS') return next();
  const publicPaths = ['/health', '/healthz', '/', '/api/v1/health'];
  if (publicPaths.includes(req.path)) return next();

  if (req.method === 'GET' && (req.path.startsWith('/api/v1/repid/') || req.path.startsWith('/api/v1/erc8004/validate/'))) {
    return next();
  }

  // Reponomics demo endpoints â€” public per sprint Phase 8.
  if (req.method === 'GET' && req.path.startsWith('/api/v1/builder/')) return next();
  if (req.method === 'GET' && req.path.startsWith('/api/v1/trader/')) return next();
  if (req.method === 'GET' && req.path.startsWith('/api/v1/demo/')) return next();
  if (req.method === 'POST' && req.path === '/api/v1/demo/two-builder/bootstrap') return next();
  if (req.method === 'POST' && req.path === '/api/v1/demo/run-round-anonymous') return next();
  if (req.method === 'POST' && req.path === '/api/v1/builder/token-signup') return next();
  if (req.method === 'POST' && req.path === '/api/v1/stake/deposit') return next();
  if (req.method === 'POST' && req.path === '/api/v1/tip/request') return next();
  if (req.method === 'POST' && /^\/api\/v1\/tip\/deliver\/[^/]+$/.test(req.path)) return next();
  if (req.method === 'POST' && req.path === '/api/v1/bet/place') return next();
  if (req.method === 'POST' && req.path === '/api/v1/bet/resolve') return next();
  // /trader/round/start is gated by Sean-signature (not API key) â€” handled in the route.
  if (req.method === 'POST' && req.path === '/api/v1/trader/round/start') return next();
  if (req.method === 'POST' && req.path === '/api/v1/trader/round/resolve-open') return next();

  // v11 external endpoints â€” per-agent bearer auth handled inside the route,
  // or fully public (register / RepID card / VDR / LLM trust leaderboard).
  if (req.path === '/api/v1/agents/register' && req.method === 'POST') return next();
  if (req.method === 'POST' && /^\/api\/v1\/agents\/[^/]+\/score-event$/.test(req.path)) return next();
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/(repid|vdr)$/.test(req.path)) return next();
  // Sprint A5: public agent card (no private fields exposed)
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/card$/.test(req.path)) return next();
  // 2026-07-23: public per-agent reputation reads for the trustrepid.dev
  // glass-box surface — history (curated fields only, no raw metadata),
  // badges (public achievements), ethics (same computeEthics as /card),
  // zkp tiered disclosure (self-redacting for humans). All read-only.
  // routes/agents.ts is mounted at root, so these are BARE paths; the
  // optional /api/v1 prefix keeps the bypass robust to either mount.
  if (req.method === 'GET' && /^(\/api\/v1)?\/agents\/[^/]+\/(history|badges|ethics)$/.test(req.path)) return next();
  if (req.method === 'GET' && /^(\/api\/v1)?\/agents\/[^/]+\/zkp\/[A-Za-z]+$/.test(req.path)) return next();
  // Public activity feed (curated fields, human agents anonymized server-side).
  if (req.method === 'GET' && /^(\/api\/v1)?\/events\/recent$/.test(req.path)) return next();
  // Sprint 6: public ERC-8004 verification surface (mint-status, onchain)
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/(mint-status|onchain)$/.test(req.path)) return next();
  // Sprint 12 (megasprint): public Graph RAG recall surface
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/recall$/.test(req.path)) return next();
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/memory\/recent$/.test(req.path)) return next();
  // Wave 6: ERC-8004 spec — public registration file + reputation reads
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/registration\.json$/.test(req.path)) return next();
  if (req.method === 'GET' && /^\/api\/v1\/agents\/[^/]+\/reputation\/(payload\.json|onchain)$/.test(req.path)) return next();
  if (req.method === 'GET' && req.path === '/api/v1/llm-trust') return next();
  // Sprint 1: x402 inbound demo bypass
  if (req.method === 'POST' && /^\/api\/v1\/agents\/[^/]+\/trade-analysis$/.test(req.path)) return next();

  // Sprint A8: bypass global auth for keys (key-management.ts handles it)
  if (/^\/api\/v1\/agents\/[^/]+\/keys/.test(req.path)) {
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

  // API key issuance V0 (2026-05-24): if the env-var allowlist didn't match, fall through to a
  // DB-issued key (agent_api_keys, hashed). Backward compatible — env keys still win first, and the
  // DB lookup uses only existing columns (agent_id/scopes), so it works before the tier/rate-limit
  // migration is applied. DB-issued keys are tagged tier='testnet' until tier wiring lands.
  let dbAgentId: string | undefined;
  if (!valid) {
    try {
      const dbKey = await validateAgentApiKey(apiKey);
      if (dbKey) {
        valid = true;
        tier = 'testnet';
        dbAgentId = dbKey.agent_id;
      }
    } catch (e) {
      // DB unreachable → fall through to the 403 below (env path already failed).
    }
  }

  // Best-effort log to Supabase. Successful auth attempts fire on EVERY request and were the
  // dominant source of trinity_agent_logs churn (~1.8M rows) — log them at 'info' so they are
  // subject to AGENT_LOG_SAMPLE. FAILED auth attempts are security-relevant, so log at 'warn'
  // (never sample-dropped).
  await logAgentEvent(
    {
      action: 'api_auth_attempt',
      agent: valid
        ? ((req.headers['x-agent-name'] as string) || 'api-gateway')
        : 'UNAUTHENTICATED',
      metadata: {
        success: valid,
        tier,
        path: req.path,
        method: req.method,
        ip: req.ip
      }
    },
    valid ? 'info' : 'warn'
  );

  if (!valid) {
    return res.status(403).json({ error: 'Forbidden: Invalid API key' });
  }

  (req as any).apiKey = { key: apiKey, tier };
  if (dbAgentId) {
    (req as any).agent_id = dbAgentId;

    // f2-authz: reject agent_id that doesn't match the key's bound identity
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
      console.warn('[authMiddleware] repid_agents lookup failed (possibly mocked DB):', e);
    }

    if (targetAgentId || targetAgentName) {
      if (targetAgentId && String(targetAgentId).trim().toLowerCase() !== String(dbAgentId).trim().toLowerCase()) {
        if (!boundAgentName || String(targetAgentId).trim().toLowerCase() !== boundAgentName.toLowerCase()) {
          return res.status(403).json({ error: 'Forbidden: agent_id mismatch (API key is bound to a different agent identity)' });
        }
      }

      if (targetAgentName && boundAgentName && String(targetAgentName).trim().toLowerCase() !== boundAgentName.toLowerCase()) {
        if (String(targetAgentName).trim().toLowerCase() !== dbAgentId.toLowerCase()) {
          return res.status(403).json({ error: 'Forbidden: agent_name mismatch (API key is bound to a different agent identity)' });
        }
      }
    }

    // Check for UUID or name in URL path
    const pathParts = req.path.split('/');
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const pathUuid = pathParts.find(p => uuidRe.test(p));
    if (pathUuid && pathUuid.toLowerCase() !== dbAgentId.toLowerCase()) {
      return res.status(403).json({ error: 'Forbidden: agent_id in path mismatch (API key is bound to a different agent identity)' });
    }

    const lastPart = pathParts[pathParts.length - 1];
    if (lastPart && lastPart.length > 0 && !uuidRe.test(lastPart)) {
      // If lastPart is not a UUID, check if it matches the bound agent name
      if (boundAgentName && lastPart.toLowerCase() !== boundAgentName.toLowerCase() && 
          // filter out generic route paths
          !['verify', 'complete', 'status', 'receipts', 'register', 'score-event', 'card', 'mint-status', 'onchain', 'recall', 'recent', 'registration.json', 'payload.json', 'keys'].includes(lastPart.toLowerCase())) {
        return res.status(403).json({ error: 'Forbidden: agent identity in path mismatch (API key is bound to a different agent identity)' });
      }
    }
  }
  next();
};

