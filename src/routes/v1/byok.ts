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
import { db } from '../../db';
import { verifyWalletMessage } from '../../services/wallet-signature';
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
import { MAX_LIFETIME_S, OWNER_ACTIONS, OWNER_AUTH_DOMAIN, OWNER_AUTH_TYPES } from '../../services/owner-authorization';
import {
  mintForOwner, mintClaimable, reclaim, revokeToken, listTokens,
  IDENTITY_TOKENS_ENABLED,
} from '../../services/identity-token';

const router = Router();

/** How stale a signed request may be. Long enough for a human, short enough to bound replay. */
const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * repid_agents.id is a uuid column. A value of exactly this shape is safe to hand to
 * .eq('id', …); anything else (a slug like "trinity-sophia", a bare name) must be
 * resolved against agent_name instead, or Postgres raises 22P02 "invalid input syntax
 * for type uuid" on the cast. Same shape the public read routes use to accept a slug OR
 * a uuid (src/routes/repid.ts resolveAgentUuid, services/human-agent-binding.ts).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agent's own API key — the second side of a bind (see human-agent-binding.ts). A browser may
 * send it only because src/config/cors-headers.ts allows it; that file also explains why every
 * /bind from trustshell.dev died in preflight until 2026-10-07.
 */
export const AGENT_KEY_HEADER = 'x-agent-key';

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

  const checked = await verifyWalletMessage(wallet, authMessage(req.method, req.baseUrl + req.path, wallet, timestamp), signature);
  if (!checked.ok) {
    if (checked.reason === 'not_checked') {
      // We could not look. Saying "bad signature" would send someone to re-sign something
      // that may have been fine; saying nothing would let an unverified wallet through.
      res.status(503).json({ error: 'signature_not_checked', message: checked.detail });
      return null;
    }
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

// ── Getting an account at all ────────────────────────────────────────────────

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

// ── BYOK custody ───────────────────────────────────────────────────────────────────

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

// ── HyperDAG identity tokens (hdg_byok_*) ────────────────────────────────────
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
    // "bypass" is what this said until 2026-08-25, and it was true of the code
    // and misleading about the cost: the token exempts you from the shared free
    // tier and gives you your own metered budget instead. It is not unmetered,
    // and — despite "BYOK" — it does not make you spend your own provider
    // credits, which is exactly the misreading the old wording invited.
    grants: [
      'own daily evaluation budget, separate from the shared free tier',
      'run attribution to a RepID',
    ],
    does_not_grant: [
      'access to provider keys',
      'custody of any secret',
      'unmetered usage',
    ],
    claimable_minting: 'requires an invite code, and is capped at a fixed number of live tokens',
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
  const { claim_commitment, label, invite_code } = req.body ?? {};
  if (typeof claim_commitment !== 'string') {
    return res.status(400).json({ error: 'bad_request', message: 'claim_commitment (client-computed Poseidon2 commitment) is required.' });
  }
  // The invite code may also arrive as a header, because this body is scanned by
  // the SQL-keyword sanitizer in index.ts and a code containing ';' or '--' would
  // be rejected before reaching here. Accepting both means an operator can pick
  // any code they like without discovering that constraint the hard way.
  const headerCode = req.headers['x-byok-invite'];
  const suppliedCode =
    typeof invite_code === 'string'
      ? invite_code
      : Array.isArray(headerCode) ? headerCode[0] : (headerCode ?? '');

  const result = await mintClaimable({
    claimCommitment: claim_commitment,
    label: typeof label === 'string' ? label : undefined,
    inviteCode: String(suppliedCode),
  });
  const status = result.ok
    ? 201
    : result.reason === 'disabled'
      ? 503
      // 403, not 400: the request was well-formed and the caller simply may not
      // make it. Returning 400 would send them off checking their commitment.
      : result.reason === 'forbidden'
        ? 403
        : 400;
  return res.status(status).json(result);
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

// ── Owner authorization ──────────────────────────────────────────────────────────

/**
 * What an owner signs to widen what their agent may do, served by the code that verifies it so a
 * client never has to rebuild the shape (services/owner-authorization.ts). Public: it authorizes
 * nothing by itself.
 */
router.get('/owner-authorization', (_req: Request, res: Response) => {
  res.json({
    domain: OWNER_AUTH_DOMAIN,
    types: OWNER_AUTH_TYPES,
    primary_type: 'OwnerAuthorization',
    actions: OWNER_ACTIONS,
    max_lifetime_seconds: MAX_LIFETIME_S,
    params: 'keccak256 of canonical JSON (keys sorted at every depth, no whitespace) of the exact settings',
    send_as: 'owner_authorization: { signature, nonce, expires_at } in the request body',
  });
});

// ── Human ↔ agent binding ──────────────────────────────────────────────────────

/** The exact text to sign to claim an agent. Public — it proves nothing by itself. */
router.get('/human/bind/message', (req: Request, res: Response) => {
  const wallet = String(req.query.wallet ?? '');
  const agentId = String(req.query.agent_id ?? '');
  if (!wallet || !agentId) {
    return res.status(400).json({ error: 'bad_request', message: 'wallet and agent_id are required.' });
  }
  return res.json({ message: bindingMessage({ wallet, agentId, scope: SCOPE_OWNERSHIP }), scope: SCOPE_OWNERSHIP });
});

/**
 * Public preflight: what claiming THIS agent will take, and what state it is in —
 * answered BEFORE the first wallet prompt, so a person decides with the facts in
 * front of them instead of discovering them one popup at a time.
 *
 * It mints no credential and takes none: every field here is already public
 * (the owner wallet via GET /agents/:id/owner, the RepID via GET /repid/*), so this
 * only aggregates them into one honest "here is what happens next". `wallet` is
 * optional and used ONLY to tell the caller "you already own this" — it is not a
 * proof and grants nothing.
 *
 * THREE OUTCOMES, never two. If the database cannot be read, this answers 503
 * `not_checked` rather than guessing a state — saying "unclaimed" on a failed read
 * would be the fail-open overclaim the /owner route exists to avoid. And it never
 * softens the cost: the two deliberate signatures and the agent's own key are named
 * as requirements, because an unexplained second popup reads as a bug and a claim
 * that silently needs a key the person does not have is a dead end.
 */
router.get('/human/bind/preflight', async (req: Request, res: Response) => {
  const agentId = String(req.query.agent_id ?? '').trim();
  if (!agentId) {
    return res.status(400).json({ error: 'bad_request', message: 'agent_id is required.' });
  }
  const walletQ = String(req.query.wallet ?? '').trim().toLowerCase();

  // Public, honest about the two prompts and the agent key — the same cost the
  // bind path will charge. Never advertised as cheaper than it is.
  const requires = {
    agent_key: true,
    wallet_signatures: 2,
    wallet_signature_steps: ['auth', 'binding'] as const,
    asks_for_email_or_name: false,
    instant: true, // no cooldown on testnet — the binding is live the moment it is written
  };

  // Does the agent exist, and what is its PUBLIC standing (what you are claiming)?
  //
  // Resolve by UUID or by slug, exactly as the public read routes already do
  // (GET /repid/:id resolves either; GET /agents/by-name/:name is the .ilike lookup).
  // repid_agents.id is a uuid column, so passing a slug like "trinity-sophia" into
  // .eq('id', …) makes Postgres raise 22P02 "invalid input syntax for type uuid". That
  // is a MALFORMED-INPUT error, not a failed read: routing it to 503 not_checked would
  // conflate "bad input" with "we could not check" (the three-outcomes rule) and leak
  // the raw DB error. So a non-UUID is matched against agent_name and, if nothing
  // matches, falls through to the honest exists:false / agent_not_found below.
  let agentRow: { id: string; agent_name: string | null; current_repid: number | null; tier: string | null } | null;
  try {
    const base = db.from('repid_agents').select('id, agent_name, current_repid, tier');
    const scoped = UUID_RE.test(agentId)
      ? base.eq('id', agentId)
      : base.ilike('agent_name', agentId).limit(1);
    const { data, error } = await scoped.maybeSingle();
    if (error) throw new Error(error.message);
    agentRow = (data as typeof agentRow) ?? null;
  } catch (e: any) {
    // A genuine failed read (a real DB error), never a malformed id — those resolve to
    // agent_not_found above. The raw error is logged server-side, never returned to the
    // client: this is a public surface.
    console.error(`[preflight] agent read failed for "${agentId}": ${e?.message ?? e}`);
    return res.status(503).json({
      error: 'not_checked',
      message: 'Could not read this agent, so nothing is claimed about its state.',
    });
  }

  if (!agentRow) {
    return res.json({
      agent_id: agentId,
      bind_enabled: HUMAN_AGENT_BIND_ENABLED,
      exists: false,
      agent: null,
      ownership: { state: 'UNKNOWN' as const },
      claimable: false,
      reason: 'agent_not_found' as const,
      requires,
      next: 'No agent with that ID exists. Check the ID, or create an agent first.',
    });
  }

  // Ownership: PROVEN (signed) vs LINKED (administrative, nobody signed) — kept apart
  // exactly as GET /agents/:id/owner does. A failed read is a 503, not "unowned".
  let owner: Awaited<ReturnType<typeof ownerOfAgent>>;
  let link: Awaited<ReturnType<typeof linkedButUnbound>>;
  try {
    // Pass the RESOLVED uuid, never the raw slug: both helpers query by uuid
    // (human_agent_bindings.agent_id, repid_agents.id), so a slug would miss the
    // binding (wrongly reporting "unowned") or hit the same 22P02 uuid-cast error.
    owner = await ownerOfAgent(agentRow.id);
    link = await linkedButUnbound(agentRow.id);
  } catch (e: any) {
    console.error(`[preflight] owner read failed for "${agentRow.id}": ${e?.message ?? e}`);
    return res.status(503).json({
      error: 'not_checked',
      message: 'Could not read who owns this agent, so nothing is claimed about it.',
    });
  }

  const agent = {
    name: agentRow.agent_name,
    repid: agentRow.current_repid,
    tier: agentRow.tier,
  };

  if (owner) {
    const ownerWallet = String(owner.human_wallet ?? '').toLowerCase();
    const ownedByYou = !!walletQ && ownerWallet === walletQ;
    return res.json({
      agent_id: agentId,
      bind_enabled: HUMAN_AGENT_BIND_ENABLED,
      exists: true,
      agent,
      ownership: {
        state: 'OWNED' as const,
        owner_wallet: owner.human_wallet ?? null, // public — the /owner route returns it too
        owner_kind: owner.owner_kind ?? null,
        bound_at: owner.bound_at ?? null,
        owned_by_you: ownedByYou,
      },
      claimable: false,
      reason: 'already_owned' as const,
      requires,
      next: ownedByYou
        ? 'You already own this agent — nothing to claim. You can manage or revoke it from your agents.'
        : 'This agent already has an owner. Its current owner has to revoke before it can be claimed again.',
    });
  }

  // Unowned. It may still be LINKED to an account administratively — that is not
  // ownership, and a viewer must see the difference.
  const linkedNotOwned = !!link.builder_id;
  const claimable = HUMAN_AGENT_BIND_ENABLED;
  return res.json({
    agent_id: agentId,
    bind_enabled: HUMAN_AGENT_BIND_ENABLED,
    exists: true,
    agent,
    ownership: {
      state: linkedNotOwned ? ('LINKED_NOT_OWNED' as const) : ('UNOWNED' as const),
      linked_account: link.builder_id,
      owned_by_you: false,
    },
    claimable,
    reason: claimable ? ('claimable' as const) : ('binding_disabled' as const),
    requires,
    next: claimable
      ? 'Unclaimed. Claiming takes two wallet signatures (one to prove you hold the key, one to claim the agent) and the agent’s own key — which this browser supplies automatically for agents made here, or you paste it for one made elsewhere. No email, no name. The binding is live instantly.'
      : 'Claiming is switched off on this deployment, so there is no way to finish claiming yet. Nothing you did is wrong — this is a server setting.',
  });
});

router.post('/human/bind', async (req: Request, res: Response) => {
  const p = await principalOf(req, res);
  if (!p) return;

  const { agent_id, signature, scope } = req.body ?? {};
  if (typeof agent_id !== 'string' || !agent_id) {
    return res.status(400).json({ error: 'bad_request', message: 'agent_id is required.' });
  }

  // The human is taken from the proven principal, never from the body — a caller
  // may not bind an agent on somebody else's behalf. The agent's key comes in a
  // header, never the body, so it is not echoed by anything that logs bodies.
  const agentKeyHeader = req.headers[AGENT_KEY_HEADER];
  const agentKey = Array.isArray(agentKeyHeader) ? agentKeyHeader[0] : agentKeyHeader;
  const result = await bindOwnerToAgent({
    owner: p.owner,
    agentId: agent_id,
    signature: typeof signature === 'string' ? signature : undefined,
    scope: typeof scope === 'string' ? scope : undefined,
    agentKey: typeof agentKey === 'string' && agentKey.trim() ? agentKey.trim() : undefined,
  });
  const status = result.ok
    ? 201
    : result.reason === 'disabled' || result.reason === 'signature_not_checked'
      ? 503
      : result.reason === 'agent_key_mismatch'
        ? 403
        : 400;
  return res.status(status).json(result);
});

router.delete('/human/bind/:agentId', async (req: Request, res: Response) => {
  const p = await principalOf(req, res);
  if (!p) return;

  // Only the current owner may revoke.
  let owner: Awaited<ReturnType<typeof ownerOfAgent>>;
  try {
    owner = await ownerOfAgent(String(req.params.agentId));
  } catch (e: any) {
    return res.status(503).json({ error: 'owner_not_checked', message: `Could not read who owns this agent, so nothing was changed. ${e?.message ?? ''}`.trim() });
  }
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
  let owner: Awaited<ReturnType<typeof ownerOfAgent>>;
  let link: Awaited<ReturnType<typeof linkedButUnbound>>;
  try {
    owner = await ownerOfAgent(agentId);
    link = await linkedButUnbound(agentId);
  } catch (e: any) {
    // Not "unowned": we could not look. Saying "No owner" here would be the overclaim this route
    // exists to avoid.
    return res.status(503).json({ error: 'owner_not_checked', message: `Could not read who owns this agent. ${e?.message ?? ''}`.trim() });
  }

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
