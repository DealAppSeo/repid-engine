/**
 * Self-serve agent API keys — challenge/response, no human in the loop.
 *
 * Own namespace (/api/v1/agent-keys/*) rather than under /agents/:id/keys, which
 * already exists and is admin-gated. Two different things with two different
 * proofs should not share a path where a regex could confuse them.
 *
 * Mounted BEFORE authMiddleware for the obvious reason: the caller has no key
 * yet — that is the entire point. Authorization is the signature, checked in the
 * service.
 */

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  createKeyChallenge,
  issueSelfServeKey,
  AGENT_SELF_SERVE_KEYS_ENABLED,
  SELF_SERVE_SCOPES,
} from '../../services/agent-self-serve-key';

export const agentKeysRouter = Router();

// Cheap per-IP brake. The real limits are the per-agent hourly cap and the
// signature itself; this only stops someone spraying the endpoint.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * GET /api/v1/agent-keys — what this surface is, before you use it.
 * Public and honest about being off when it is off, so a discovering agent
 * learns that from the API rather than from a 404.
 */
agentKeysRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    enabled: AGENT_SELF_SERVE_KEYS_ENABLED,
    scopes: SELF_SERVE_SCOPES,
    how: [
      'POST /api/v1/agent-keys/challenge { agent_id } → { nonce, message }',
      'sign `message` with the wallet in repid_agents.wallet_address',
      'POST /api/v1/agent-keys/issue { nonce, signature } → { key }',
    ],
    notes: [
      'The key is bound to that agent: it can act as that agent and no other.',
      "'admin' is never granted this way — issuing keys for other agents stays human-gated.",
      'Issuing revokes any previous self-serve key for the same agent.',
      'The key is shown ONCE. It is stored hashed and cannot be recovered.',
    ],
  });
});

agentKeysRouter.post('/challenge', limiter, async (req: Request, res: Response) => {
  const agentId = typeof req.body?.agent_id === 'string' ? req.body.agent_id.trim() : '';
  if (!agentId) {
    return res.status(400).json({ error: 'bad_request', message: 'agent_id is required.' });
  }
  const r = await createKeyChallenge(agentId);
  if (!r.ok) {
    const status =
      r.reason === 'disabled' ? 503 : r.reason === 'agent_not_found' ? 404 : r.reason === 'rate_limited' ? 429 : 400;
    return res.status(status).json({ error: r.reason, message: r.detail });
  }
  return res.json({
    nonce: r.nonce,
    message: r.message,
    expires_in_seconds: r.expires_in_seconds,
    sign_with: r.wallet,
  });
});

agentKeysRouter.post('/issue', limiter, async (req: Request, res: Response) => {
  const nonce = typeof req.body?.nonce === 'string' ? req.body.nonce.trim() : '';
  const signature = typeof req.body?.signature === 'string' ? req.body.signature.trim() : '';
  if (!nonce || !signature) {
    return res.status(400).json({ error: 'bad_request', message: 'nonce and signature are both required.' });
  }
  const r = await issueSelfServeKey({ nonce, signature });
  if (!r.ok) {
    const status = r.reason === 'disabled' ? 503 : r.reason === 'write_failed' ? 500 : 400;
    return res.status(status).json({ error: r.reason, message: r.detail });
  }
  return res.json({
    key: r.key,
    key_prefix: r.key_prefix,
    agent_id: r.agent_id,
    scopes: r.scopes,
    revoked_previous: r.revoked_previous,
    warning: 'This key is shown once and stored hashed. Save it now — it cannot be recovered.',
  });
});

export default agentKeysRouter;
