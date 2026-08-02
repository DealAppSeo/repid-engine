/**
 * byok.ts — BYOK key custody + human↔agent binding, over an identity that
 * cannot be claimed by setting a header.
 *
 * WHY NOT resolveSbt(). The existing controller auth resolves a human from an
 * `x-sbt-wallet` or `x-sbt-token` header and a lookup. That is fine for reading
 * a dashboard, and completely unsuitable here: wallet addresses are PUBLIC, so
 * anyone who can read a block explorer could list or overwrite someone else's
 * provider keys. This is the same shape as the f2-authz bypass already fixed in
 * this repo — an identity asserted rather than proven.
 *
 * So every request on this router proves control of the wallet by signing a
 * statement that names the method, the path and a timestamp. The server recovers
 * the signer; nothing is read from a header as identity. A captured signature
 * cannot be replayed onto a different route, and expires in five minutes.
 *
 * Both features are behind default-OFF flags (BYOK_CUSTODY_ENABLED,
 * HUMAN_AGENT_BIND_ENABLED) — original work touching live state lands
 * finished-and-inert per CLAUDE_RULES 23.
 */
import { Router, Request, Response } from 'express';
import { verifyMessage } from 'ethers';
import { db } from '../../db';
import {
  storeProviderKey, listKeys, revokeKey, ownerFamilyWidth,
  BYOK_CUSTODY_ENABLED, type KeyOwner,
} from '../../services/byok-custody';
import {
  bindHumanToAgent, revokeBinding, ownerOfAgent, agentsOfHuman, bindingMessage,
  HUMAN_AGENT_BIND_ENABLED, SCOPE_OWNERSHIP,
} from '../../services/human-agent-binding';
import { supportedProviders } from '../../services/provider-key-probe';

const router = Router();

/** How stale a signed request may be. Long enough for a human, short enough to bound replay. */
const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * The statement a caller signs. Binding it to METHOD and PATH is what stops a
 * signature gathered for a harmless read being replayed against a write.
 */
export function authMessage(method: string, path: string, wallet: string, timestamp: string): string {
  return [
    'HyperDAG — authenticated request',
    `method: ${method.toUpperCase()}`,
    `path:   ${path}`,
    `wallet: ${wallet.toLowerCase()}`,
    `time:   ${timestamp}`,
  ].join('\n');
}

interface Principal { wallet: string; humanTokenId: string; }

/**
 * Resolve WHO is calling, from cryptography rather than assertion.
 * Returns null and writes the response on any failure.
 */
async function principalOf(req: Request, res: Response): Promise<Principal | null> {
  const wallet = String(req.headers['x-hd-wallet'] ?? '').trim();
  const signature = String(req.headers['x-hd-signature'] ?? '').trim();
  const timestamp = String(req.headers['x-hd-timestamp'] ?? '').trim();

  if (!wallet || !signature || !timestamp) {
    res.status(401).json({
      error: 'signature_required',
      message: 'Send x-hd-wallet, x-hd-timestamp and x-hd-signature. Your key custody is not protected by a header anyone could guess.',
      sign_this: authMessage(req.method, req.baseUrl + req.path, wallet || '<your wallet>', '<ISO timestamp>'),
    });
    return null;
  }

  const age = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > MAX_SKEW_MS) {
    res.status(401).json({ error: 'stale_signature', message: 'Timestamp is missing, malformed, or more than 5 minutes from now.' });
    return null;
  }

  let recovered: string;
  try {
    recovered = verifyMessage(authMessage(req.method, req.baseUrl + req.path, wallet, timestamp), signature);
  } catch {
    res.status(401).json({ error: 'bad_signature', message: 'Signature could not be verified.' });
    return null;
  }
  if (recovered.toLowerCase() !== wallet.toLowerCase()) {
    res.status(401).json({ error: 'bad_signature', message: 'Signature did not recover to the wallet it claims.' });
    return null;
  }

  // Proving a wallet is not the same as being a verified human. Both are required.
  const { data } = await db
    .from('human_sbt_registry')
    .select('token_id, wallet_address')
    .ilike('wallet_address', wallet)
    .limit(1);
  const row = data?.[0];
  if (!row) {
    res.status(403).json({
      error: 'human_not_verified',
      message: 'That wallet proved control but is not a verified human. Complete human verification first.',
    });
    return null;
  }
  return { wallet, humanTokenId: row.token_id };
}

const ownerFor = (p: Principal): KeyOwner => ({ kind: 'human_sbt', id: p.humanTokenId });

// ── BYOK custody ────────────────────────────────────────────────────────────

router.get('/byok/providers', (_req: Request, res: Response) => {
  res.json({ enabled: BYOK_CUSTODY_ENABLED, providers: supportedProviders() });
});

/**
 * Store a provider key. The key is VERIFIED against its provider before it is
 * written, and never returned by any endpoint afterwards.
 */
router.post('/byok/keys', async (req: Request, res: Response) => {
  const p = await principalOf(req, res);
  if (!p) return;

  const { provider, api_key, label } = req.body ?? {};
  if (typeof provider !== 'string' || typeof api_key !== 'string' || !api_key) {
    return res.status(400).json({ error: 'bad_request', message: 'provider and api_key are required.' });
  }

  const result = await storeProviderKey(ownerFor(p), provider, api_key, typeof label === 'string' ? label : undefined);
  // The key itself appears nowhere in this response, including on failure.
  return res.status(result.ok ? 201 : result.reason === 'disabled' ? 503 : 400).json(result);
});

router.get('/byok/keys', async (req: Request, res: Response) => {
  const p = await principalOf(req, res);
  if (!p) return;
  const keys = await listKeys(ownerFor(p));
  const width = await ownerFamilyWidth(ownerFor(p));
  return res.json({
    keys,
    ...width,
    // The number that decides whether this user's agent can get a real second
    // opinion. Two keys from the same family is one vote, not two.
    note:
      width.width >= 3
        ? `${width.width} independent families — enough for a quorum that can actually disagree.`
        : `${width.width} independent famil${width.width === 1 ? 'y' : 'ies'}. Below 3, verification cannot outvote a confident wrong answer.`,
  });
});

router.delete('/byok/keys/:provider', async (req: Request, res: Response) => {
  const p = await principalOf(req, res);
  if (!p) return;
  const label = typeof req.query.label === 'string' ? req.query.label : 'default';
  return res.json(await revokeKey(ownerFor(p), String(req.params.provider), label));
});

// ── Human ↔ agent binding ───────────────────────────────────────────────────

/** The exact text to sign to claim an agent. Public — it proves nothing by itself. */
router.get('/human/bind/message', (req: Request, res: Response) => {
  const wallet = String(req.query.wallet ?? '');
  const agentId = String(req.query.agent_id ?? '');
  if (!wallet || !agentId) {
    return res.status(400).json({ error: 'bad_request', message: 'wallet and agent_id are required.' });
  }
  return res.json({ message: bindingMessage({ wallet, agentId, scope: SCOPE_OWNERSHIP }), scope: SCOPE_OWNERSHIP });
});

router.post('/human/bind', async (req: Request, res: Response) => {
  const p = await principalOf(req, res);
  if (!p) return;

  const { agent_id, signature, scope } = req.body ?? {};
  if (typeof agent_id !== 'string' || !agent_id) {
    return res.status(400).json({ error: 'bad_request', message: 'agent_id is required.' });
  }

  // The human is taken from the proven principal, never from the body — a caller
  // may not bind an agent on somebody else's behalf.
  const result = await bindHumanToAgent({
    humanTokenId: p.humanTokenId,
    agentId: agent_id,
    signature: typeof signature === 'string' ? signature : undefined,
    scope: typeof scope === 'string' ? scope : undefined,
  });
  return res.status(result.ok ? 201 : result.reason === 'disabled' ? 503 : 400).json(result);
});

router.delete('/human/bind/:agentId', async (req: Request, res: Response) => {
  const p = await principalOf(req, res);
  if (!p) return;

  // Only the current owner may revoke.
  const owner = await ownerOfAgent(String(req.params.agentId));
  if (!owner || owner.human_token_id !== p.humanTokenId) {
    return res.status(403).json({ error: 'not_owner', message: 'You do not currently own this agent.' });
  }
  return res.json(await revokeBinding(String(req.params.agentId)));
});

/** "My team of experts" — every agent this caller owns. */
router.get('/human/agents', async (req: Request, res: Response) => {
  const p = await principalOf(req, res);
  if (!p) return;
  return res.json({ enabled: HUMAN_AGENT_BIND_ENABLED, agents: await agentsOfHuman(p.humanTokenId) });
});

/** Public: who owns this agent. Ownership is meant to be checkable. */
router.get('/agents/:agentId/owner', async (req: Request, res: Response) => {
  const owner = await ownerOfAgent(String(req.params.agentId));
  if (!owner) return res.json({ owned: false, owner: null });
  return res.json({
    owned: true,
    owner: { human_token_id: owner.human_token_id, wallet: owner.human_wallet, bound_at: owner.bound_at, scope: owner.scope },
  });
});

export default router;
