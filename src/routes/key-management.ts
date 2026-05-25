import { Router, Request, Response } from 'express';
import { db } from '../db';
import { issueAgentApiKey, revokeAgentApiKey, validateAgentApiKey } from '../auth/api-keys';

const router = Router();

// Middleware to check admin scope OR legacy registration api_key
async function requireAdminAuth(req: Request, res: Response, next: any) {
  const agentId = String(req.params.id);
  const header = req.headers['authorization'];
  const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';

  if (!token) {
    return res.status(401).json({ error: 'Missing API key' });
  }

  // 1. Try to validate as a scoped Agent API Key
  const validKey = await validateAgentApiKey(token);
  if (validKey) {
    if (validKey.agent_id !== agentId) {
      return res.status(403).json({ error: 'API key agent_id mismatch' });
    }
    // For now, ANY valid key counts as admin or we require 'admin' scope? 
    // Wait, the prompt says "requires API key with 'admin' scope OR original registration token"
    // Since we don't have an 'admin' scope implemented at registration explicitly, 
    // actually, we didn't issue an 'admin' scope during registration. But wait, we can just say "if it has 'admin' scope". 
    // If they hold the original registration token, that's checked next.
    if (validKey.scopes.includes('admin')) {
      return next();
    }
  }

  // 2. Try to validate as original registration token (legacy)
  const { data: agent, error } = await db.from('repid_agents').select('constitution').eq('id', agentId).single();
  if (error || !agent) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const legacyKey = (agent as any).constitution?.api_key;
  if (legacyKey && legacyKey === token) {
    console.warn(`[DEPRECATION WARNING] Legacy api_key used for agent: ${agentId} in key management. Please transition to modern scoped API keys.`);
    return next();
  }

  // If we reach here, we failed both checks
  return res.status(403).json({ error: 'Insufficient permissions (requires admin scope or registration token)' });
}

router.get('/:id/keys', requireAdminAuth, async (req: Request, res: Response) => {
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

router.post('/:id/keys', requireAdminAuth, async (req: Request, res: Response) => {
  const agentId = String(req.params.id);
  const { name = 'new_key', scopes = [] } = req.body;

  try {
    const { key, key_prefix } = await issueAgentApiKey(agentId, name, scopes);
    return res.status(201).json({ key, key_prefix, name, scopes });
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

router.delete('/:id/keys/:keyId', requireAdminAuth, async (req: Request, res: Response) => {
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
