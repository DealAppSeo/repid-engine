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
  bindOwnerToAgent, revokeBinding, ownerOfAgent, agentsOfOwner, linkedButUnbound,
  bindingMessage, assuranceOf,
  HUMAN_AGENT_BIND_ENABLED, SCOPE_OWNERSHIP, type OwnerRef,
} from '../../services/human-agent-binding';
import { supportedProviders } from '../../services/provider-key-probe';
import {
  mintForOwner, mintClaimable, reclaim, revokeToken, listTokens,
  IDENTITY_TOKENS_ENABLED,
} from '../../services/identity-token';

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

interface Principal { wallet: string; owner: OwnerRef; }

/**
 * Prove the caller controls a wallet. Says nothing about who they are here.
 *
 * Split out from principalOf so that connecting an account can require the same
 * proof without needing an account to already exist — otherwise creating your
 * first account would require having one.
 */
async function provenWallet(req: Request, res: Response): Promise<string | null> {
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
  return wallet;
}

/**
 * Resolve WHO is calling, from cryptography rather than assertion.
 * Returns null and writes the response on any failure.
 */
async function principalOf(req: Request, res: Response): Promise<Principal | null> {
  const wallet = await provenWallet(req, res);
  if (!wallet) return null;

  // The wallet is proven. Now find WHICH account it is — checking the stronger
  // registry first, so someone who holds a proof-of-human SBT is recognised as
  // one rather than being downgraded to a plain builder.
  const { data: sbt } = await db
    .from('human_sbt_registry')
    .select('token_id')
    .ilike('wallet_address', wallet)
    .limit(1);
  if (sbt?.[0]) return { wallet, owner: { kind: 'human_sbt', id: sbt[0].token_id, wallet } };

  const { data: builder } = await db.from('builders').select('id').ilike('address', wallet).limit(1);
  if (builder?.[0]) return { wallet, owner: { kind: 'builder', id: builder[0].id, wallet } };

  // Proving a wallet is not the same as having an account. This used to demand a
  // proof-of-human SBT, which only 5 accounts hold against 73 builders — so the
  // whole feature was unreachable for almost every real user.
  res.status(403).json({
    error: 'no_account',
    message: 'That wallet proved control but has no account here yet. Connect it once to create one.',
  });
  return null;
}

// Keys are custodied under the SAME identity that owns the agents, and the kind
// is carried through unchanged. Storing a builder as an "agent" would make the
// owner column lie about who holds the key.
const ownerFor = (p: Principal): KeyOwner => ({ kind: p.owner.kind, id: p.owner.id });

// ── Getting an account at all ───────────────────────────────────────────────

const SELF_SERVE_ACCOUNTS_ENABLED = process.env.SELF_SERVE_ACCOUNTS_ENABLED === 'true';

/**
 * Connect a wallet and get an account.
 *
 * This was the one genuinely missing step. Everything downstream — custody,
 * ownership, a receipt with your name on it — needed an account, and there was
 * no way to obtain one without an operator creating it by hand. A walkthrough
 * that opens with "first, email me" is not a walkthrough.
 *
 * IDEMPOTENT. Connecting twice returns the same account rather than a second
 * one; the wallet is the identity.
 *
 * IT GRANTS NO REPUTATION. A new account starts with nothing, deliberately. If
 * connecting a wallet minted RepID, then RepID would measure how many wallets
 * someone can generate — which is free — instead of how they behaved. Reputation
 * has to be earned by doing something someone else verified.
 *
 * FLAG: SELF_SERVE_ACCOUNTS_ENABLED (default OFF). This is a new PUBLIC write
 * surface, so it lands inert per CLAUDE_RULES 23 and gets switched on
 * deliberately rather than by merging.
 */
router.post('/account/connect', async (req: Request, res: Response) => {
  if (!SELF_SERVE_ACCOUNTS_ENABLED) {
    return res.status(503).json({ error: 'disabled', message: 'Self-serve accounts are not enabled on this deployment.' });
  }
  const wallet = await provenWallet(req, res);
  if (!wallet) return;

  const { data: existing } = await db.from('builders').select('id, address, created_at').ilike('address', wallet).limit(1);
  if (existing?.[0]) {
    return res.json({ created: false, account: existing[0], note: 'You already had an account. The wallet is the identity.' });
  }

  const display = typeof req.body?.display_name === 'string' ? req.body.display_name.slice(0, 60) : null;
  const { data, error } = await db
    .from('builders')
    .insert({ address: wallet, auth_method: 'wallet', display_name: display })
    .select('id, address, created_at')
    .maybeSingle();

  if (error || !data) {
    return res.status(500).json({ error: 'write_failed', message: error?.message ?? 'insert returned no row' });
  }
  return res.status(201).json({
    created: true,
    account: data,
    reputation: 'none yet — RepID is earned by work someone else verified, never granted for signing up',
  });
});

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

// ── HyperDAG identity tokens (hdg_byok_*) ───────────────────────────────────
//
// The missing issuance path. The rate limiter has always been able to VALIDATE
// one of these and grant bypass; nothing could mint one. That is why external
// testers could not be invited — every anonymous caller shares one 10-per-IP
// bucket, so a tester and the eval harness starve each other.
//
// These tokens hold no secret of the user's. Provider keys stay in the browser
// vault by default; custody stays opt-in. This is identity and attribution only.

router.get('/byok/identity/status', (_req: Request, res: Response) => {
  res.json({
    enabled: IDENTITY_TOKENS_ENABLED,
    token_format: 'hdg_byok_<43-char base64url>',
    stored: 'sha256 of the random part, plus an 8-char display prefix. The token itself is returned once and never stored.',
    grants: ['rate-limit bypass', 'run attribution to a RepID'],
    does_not_grant: ['access to provider keys', 'custody of any secret'],
  });
});

/** Mint for a proven wallet. Optionally binds attribution to a RepID at mint. */
router.post('/byok/identity', async (req: Request, res: Response) => {
  const p = await principalOf(req, res);
  if (!p) return;
  const { repid_agent_id, label } = req.body ?? {};
  const result = await mintForOwner({
    owner: ownerFor(p),
    repidAgentId: typeof repid_agent_id === 'string' ? repid_agent_id : null,
    label: typeof label === 'string' ? label : undefined,
  });
  return res.status(result.ok ? 201 : result.reason === 'disabled' ? 503 : 400).json(result);
});

/**
 * Mint a CLAIMABLE token for someone with no wallet yet.
 *
 * Deliberately NOT behind `principalOf` — the entire point is that the caller
 * has no wallet to prove. What stands in for identity is a client-computed
 * Poseidon2 commitment whose preimage the server never sees. We take custody of
 * nothing, and can neither claim this token nor recover it for them.
 */
router.post('/byok/identity/claimable', async (req: Request, res: Response) => {
  const { claim_commitment, label } = req.body ?? {};
  if (typeof claim_commitment !== 'string') {
    return res.status(400).json({ error: 'bad_request', message: 'claim_commitment (client-computed Poseidon2 commitment) is required.' });
  }
  const result = await mintClaimable({ claimCommitment: claim_commitment, label: typeof label === 'string' ? label : undefined });
  return res.status(result.ok ? 201 : result.reason === 'disabled' ? 503 : 400).json(result);
});

/**
 * Bind a claimable token to a wallet. Requires proving the wallet AND supplying
 * the commitment whose preimage the claimant knows. Retires the claimable row
 * and issues a fresh owner-bound token, so the post-claim token was never known
 * in the pre-claim state.
 */
router.post('/byok/identity/reclaim', async (req: Request, res: Response) => {
  const p = await principalOf(req, res);
  if (!p) return;
  const { claim_commitment, repid_agent_id } = req.body ?? {};
  if (typeof claim_commitment !== 'string') {
    return res.status(400).json({ error: 'bad_request', message: 'claim_commitment is required.' });
  }
  const result = await reclaim({
    claimCommitment: claim_commitment,
    owner: ownerFor(p),
    repidAgentId: typeof repid_agent_id === 'string' ? repid_agent_id : null,
  });
  return res.status(result.ok ? 201 : result.reason === 'disabled' ? 503 : 400).json(result);
});

router.get('/byok/identity', async (req: Request, res: Response) => {
  const p = await principalOf(req, res);
  if (!p) return;
  return res.json({ tokens: await listTokens(ownerFor(p)) });
});

router.delete('/byok/identity/:id', async (req: Request, res: Response) => {
  const p = await principalOf(req, res);
  if (!p) return;
  const reason = typeof req.query.reason === 'string' ? req.query.reason : undefined;
  return res.json(await revokeToken({ id: String(req.params.id), owner: ownerFor(p), reason }));
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
  const result = await bindOwnerToAgent({
    owner: p.owner,
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
  if (!owner || owner.owner_id !== p.owner.id) {
    return res.status(403).json({ error: 'not_owner', message: 'You do not currently own this agent.' });
  }
  return res.json(await revokeBinding(String(req.params.agentId)));
});

/** "My team of experts" — every agent this caller owns. */
router.get('/human/agents', async (req: Request, res: Response) => {
  const p = await principalOf(req, res);
  if (!p) return;
  return res.json({
    enabled: HUMAN_AGENT_BIND_ENABLED,
    owner: { kind: p.owner.kind, assurance: assuranceOf(p.owner.kind) },
    agents: await agentsOfOwner(p.owner),
  });
});

/**
 * Public: who owns this agent, and on what evidence. Ownership is meant to be
 * checkable by someone who does not trust us.
 *
 * Deliberately separates two things a UI could easily conflate:
 *   PROVEN   a binding — somebody signed a statement naming this exact agent.
 *   LINKED   repid_agents.builder_id — an administrative association nobody
 *            signed. Real, useful, and NOT evidence of ownership.
 * Showing "linked" as ownership would be the same overclaim the receipt made
 * when it printed pay-on-delivery for exchanges that paid up front.
 */
router.get('/agents/:agentId/owner', async (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const owner = await ownerOfAgent(agentId);
  const link = await linkedButUnbound(agentId);

  if (!owner) {
    return res.json({
      owned: false,
      owner: null,
      linked_account: link.builder_id,
      note: link.builder_id
        ? 'This agent is linked to an account, but nobody has proved ownership by signature. Linked is not owned.'
        : 'No owner and no linked account.',
    });
  }
  return res.json({
    owned: true,
    owner: {
      kind: owner.owner_kind,
      id: owner.owner_id,
      wallet: owner.human_wallet,
      bound_at: owner.bound_at,
      scope: owner.scope,
    },
    // Never flattened to "verified" — a wallet proof and a proof-of-human are
    // different claims and the receipt has to be able to tell them apart.
    assurance: owner.assurance,
    proof: 'A signature over a message naming this agent, this wallet and this scope.',
  });
});

export default router;
