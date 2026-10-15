import { Router, Request, Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { trustedClientIp } from '../middleware/client-ip';
import { db } from '../db';
import { issueAgentApiKey, revokeAgentApiKey, validateAgentApiKey, RESERVED_SCOPES } from '../auth/api-keys';
import { SELF_SERVE_SCOPES } from '../services/agent-self-serve-key';
import { resolveAccountableRoot, rootRefusalStatus } from '../services/accountable-root';
import { checkOwnerAuthorization, readOwnerAuthorization } from '../services/owner-authorization';

const router = Router();

// Per-IP brake on a credential surface (list, mint, revoke). The real gates are the agent-bound key
// and, for minting, the accountable root's signature; this only stops someone spraying it.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  keyGenerator: (req): string => ipKeyGenerator(trustedClientIp(req)),
  standardHeaders: true,
  legacyHeaders: false,
});

// [S1 2026-10-14] SELF auth: a key bound to THIS agent. This used to require an 'admin' scope, but
// keyless registration handed 'admin' to everyone, so the scope proved nothing and the controller read
// it as admin. What a self caller may then do is bounded where it matters: creating a key needs the
// accountable root's signature (below) and cannot widen scopes beyond the self-serve set plus what the
// calling key already holds.
// [D-108 2026-10-15] agent_api_keys only. The legacy registration token (constitution.api_key) no
// longer authenticates here; it gets the same answer as any unrecognized key.
async function requireAdminAuth(req: Request, res: Response, next: any) {
  const agentId = String(req.params.id);
  const header = req.headers['authorization'];
  const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';

  if (!token) {
    return res.status(401).json({ error: 'Missing API key' });
  }

  const validKey = await validateAgentApiKey(token);
  if (!validKey) {
    return res.status(401).json({
      error: 'Invalid or revoked API key',
      message: 'Only agent API keys authenticate here; registration tokens were retired (D-108). GET /api/v1/agent-keys explains how to get one.',
    });
  }
  if (validKey.agent_id !== agentId) {
    return res.status(403).json({ error: 'API key agent_id mismatch' });
  }
  (req as any).callerScopes = validKey.scopes;
  return next();
}

router.get('/:id/keys', limiter, requireAdminAuth, async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const { data, error } = await db.from('agent_api_keys')
    .select('id, name, key_prefix, created_at, last_used_at, scopes')
    .eq('agent_id', agentId)
    .is('revoked_at', null);

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.json({ keys: data });
});

router.post('/:id/keys', limiter, requireAdminAuth, async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const { name = 'new_key', scopes = [] } = req.body;

  // [S1 2026-10-14] No escalation through self-service. Reserved scopes are never issued here, and
  // anything else must be a self-serve scope or one the calling key already holds (so `bounty_verify`
  // stays operator-granted). Checked before anything is read or signed.
  if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === 'string')) {
    return res.status(400).json({ error: 'scopes must be an array of strings' });
  }
  const callerScopes: string[] = (req as any).callerScopes ?? [];
  const refused = scopes.filter(
    (s: string) => RESERVED_SCOPES.includes(s) || !((SELF_SERVE_SCOPES as readonly string[]).includes(s) || callerScopes.includes(s)),
  );
  if (refused.length) {
    return res.status(403).json({ error: 'scope_not_grantable', scopes: refused, message: `This key cannot grant: ${refused.join(', ')}` });
  }

  // OWNER [2026-10-07] + ACCOUNTABLE ROOT [F1]. A new key is a new way to act as this agent.
  //  - Owned by a person: a key alone cannot mint another key (a leaked key would make itself
  //    permanent); only the owner's wallet can (services/owner-authorization.ts).
  //  - Held by the operator's custodian (the house fleet): [S1 2026-10-14] the custodian's signature,
  //    exactly as for an owner. This used to stand on "the admin credential this route requires is the
  //    operator's", which was never true (registration issued 'admin' to everyone) and no longer applies
  //    now that the route takes any key bound to the agent.
  //  - Nobody answers for it: refused. Before F1 an unclaimed agent's key could mint more keys for
  //    itself with no one behind any of them; claiming the agent is now the way to get a second key.
  // Revoking a key never needs any of this.
  try {
    const root = await resolveAccountableRoot(agentId);
    if (!root.ok) {
      return res.status(rootRefusalStatus(root)).json({
        error: root.code === 'not_checked' ? 'root_not_checked' : 'no_accountable_root',
        code: root.code,
        message:
          root.code === 'not_checked'
            ? `Could not check who answers for this agent, so no key was made. ${root.message}`
            : `Nobody answers for this agent yet, so it cannot be given another key. Claim it on /bind first. ${root.message}`,
      });
    }
    const check = await checkOwnerAuthorization({
      subject: agentId,
      action: 'keys.create',
      params: { agent_id: agentId, name: String(name), scopes: Array.isArray(scopes) ? [...scopes].map(String).sort() : [] },
      auth: readOwnerAuthorization(req.body),
      expectedSigner: root.root.wallet,
    });
    if (!check.ok) {
      return res.status(check.code === 'not_checked' ? 503 : 403).json({ error: check.code, message: check.message });
    }
  } catch (e: any) {
    return res.status(500).json({ error: e?.message ?? 'owner check failed' });
  }

  try {
    const { key, key_prefix } = await issueAgentApiKey(agentId, name, scopes);
    return res.status(201).json({ key, key_prefix, name, scopes });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

router.delete('/:id/keys/:keyId', limiter, requireAdminAuth, async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const keyId = String(req.params.keyId);

  // Validate the key actually belongs to the agent
  const { data, error } = await db.from('agent_api_keys')
    .select('id')
    .eq('id', keyId)
    .eq('agent_id', agentId)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: 'Key not found' });
  }

  try {
    await revokeAgentApiKey(keyId);
    return res.status(204).send();
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

export default router;
