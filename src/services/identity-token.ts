/**
 * identity-token.ts — issue and manage `hdg_byok_*` HyperDAG identity tokens.
 *
 * WHAT THIS IS NOT. Not a provider key. A user's OpenAI/Anthropic keys stay in
 * their browser vault ("never on our servers" — the /connect promise), or, only
 * under explicit consent, in `user_provider_keys` custody. An identity token is
 * OURS, issued to them, and holds no secret of theirs. It answers two questions
 * nothing else could:
 *
 *   1. who is this request, for rate-limit purposes (the bypass branch in
 *      middleware/rate-limit.ts), and
 *   2. which RepID does the resulting work accrue to.
 *
 * WHY A NEW TABLE. The validator already looked up `hdg_byok_<random>` by
 * sha256 of the random part — but in `user_api_keys`, whose NOT NULL
 * provider_name / encrypted_api_key columns exist for custodied third-party
 * secrets. Minting an identity token there meant fabricating a provider name and
 * an encrypted key for a thing that is neither, and would have surfaced phantom
 * providers in the custody listing. So the validator read a table that could
 * not hold what it was looking for, and nothing minted. Hence
 * `hdg_identity_tokens`; `user_api_keys` is untouched.
 *
 * THE SECRET IS NEVER STORED. We keep sha256(suffix) and an 8-char display
 * prefix. The full token is returned exactly once, at mint. There is no endpoint
 * that can return it again, because there is nothing to return.
 */
import crypto from 'crypto';
import { db } from '../db';

/**
 * Structurally compatible with BOTH `KeyOwner` (byok-custody) and `OwnerRef`
 * (human-agent-binding), which declare their own `OwnerKind` unions and are
 * therefore not assignable to each other. Rather than couple this service to
 * one of them — or cast the difference away, which would hide a real divergence
 * — it accepts the shape both satisfy. `kind` is validated against the table's
 * CHECK constraint at write time, so a wrong value fails loudly at the DB rather
 * than being silently accepted here.
 */
export interface TokenOwner {
  kind: string;
  id: string;
  wallet?: string;
}

/** Feature flag. Default OFF — original work touching live state (CLAUDE_RULES 23). */
export const IDENTITY_TOKENS_ENABLED = process.env.IDENTITY_TOKENS_ENABLED === 'true';

const PREFIX = 'hdg_byok_';
/** 32 bytes of CSPRNG → 43 base64url chars. Not guessable, not derived from anything. */
const SUFFIX_BYTES = 32;

/**
 * MUST match middleware/rate-limit.ts `hashByokKey`: sha256 over the random part
 * ONLY (everything after `hdg_byok_`), hex. If these two ever diverge, every
 * minted token silently fails to authenticate — so this is asserted by a test
 * that imports both rather than being trusted to stay in sync by comment.
 */
export function hashTokenSuffix(suffix: string): string {
  return crypto.createHash('sha256').update(suffix).digest('hex');
}

export interface MintResult {
  ok: boolean;
  reason?: 'disabled' | 'write_failed' | 'bad_request';
  detail: string;
  /** The ONLY time the full token exists outside the holder's hands. */
  token?: string;
  record?: {
    id: string;
    key_prefix: string;
    owner_kind: string;
    repid_agent_id: string | null;
    status: string;
    created_at: string;
  };
}

/**
 * Mint a token for a proven owner.
 *
 * `repidAgentId` binds attribution at mint time rather than later, per review:
 * a run under this token accrues to that RepID from the first request. It is
 * nullable so the wallet-less path can mint before a RepID is claimed.
 */
export async function mintForOwner(params: {
  owner: TokenOwner;
  repidAgentId?: string | null;
  label?: string;
}): Promise<MintResult> {
  if (!IDENTITY_TOKENS_ENABLED) {
    return { ok: false, reason: 'disabled', detail: 'Identity token issuance is not enabled on this deployment.' };
  }
  const suffix = crypto.randomBytes(SUFFIX_BYTES).toString('base64url');
  const row = {
    key_hash: hashTokenSuffix(suffix),
    key_prefix: suffix.slice(0, 8),
    owner_kind: params.owner.kind,
    owner_id: params.owner.id,
    owner_wallet: params.owner.wallet ?? null,
    repid_agent_id: params.repidAgentId ?? null,
    label: params.label ?? null,
  };

  const { data, error } = await db
    .from('hdg_identity_tokens')
    .insert(row)
    .select('id, key_prefix, owner_kind, repid_agent_id, status, created_at')
    .maybeSingle();

  if (error || !data) {
    return { ok: false, reason: 'write_failed', detail: error?.message ?? 'insert returned no row' };
  }
  return {
    ok: true,
    detail: 'Store this now — it is not recoverable. We keep only its hash.',
    token: `${PREFIX}${suffix}`,
    record: data as MintResult['record'],
  };
}

/**
 * Mint a CLAIMABLE token for someone with no wallet.
 *
 * The caller (client-side) generates a claim secret and sends only
 * Poseidon2(claim_secret). The server stores the commitment and never sees the
 * secret — so there is no key material to take custody of, and no payload to
 * leak. Later, `reclaim()` exchanges a preimage proof for a wallet-bound token.
 *
 * The commitment is computed by the CLIENT deliberately. If the server derived
 * it, the server would have held the secret at some instant, which is the exact
 * property this flow exists to avoid.
 */
export async function mintClaimable(params: {
  claimCommitment: string;
  label?: string;
}): Promise<MintResult> {
  if (!IDENTITY_TOKENS_ENABLED) {
    return { ok: false, reason: 'disabled', detail: 'Identity token issuance is not enabled on this deployment.' };
  }
  const c = String(params.claimCommitment ?? '').trim();
  // A commitment must look like one. Rejecting junk here keeps the unique index
  // from being filled with placeholder strings that can never be claimed.
  if (!/^(0x)?[0-9a-fA-F]{32,128}$/.test(c)) {
    return { ok: false, reason: 'bad_request', detail: 'claim_commitment must be a hex commitment (Poseidon2 output).' };
  }
  const suffix = crypto.randomBytes(SUFFIX_BYTES).toString('base64url');
  const { data, error } = await db
    .from('hdg_identity_tokens')
    .insert({
      key_hash: hashTokenSuffix(suffix),
      key_prefix: suffix.slice(0, 8),
      owner_kind: 'claimable',
      claim_commitment: c.toLowerCase(),
      label: params.label ?? null,
    })
    .select('id, key_prefix, owner_kind, repid_agent_id, status, created_at')
    .maybeSingle();

  if (error || !data) {
    const dup = /duplicate key|23505/i.test(error?.message ?? '');
    return {
      ok: false,
      reason: dup ? 'bad_request' : 'write_failed',
      detail: dup ? 'A live token already exists for that commitment.' : (error?.message ?? 'insert returned no row'),
    };
  }
  return {
    ok: true,
    detail: 'Claimable token minted. Keep the claim secret — without it this token cannot be bound to you, and we cannot recover it.',
    token: `${PREFIX}${suffix}`,
    record: data as MintResult['record'],
  };
}

/**
 * Bind a claimable token to a proven wallet.
 *
 * The holder proves knowledge of the preimage of `claim_commitment`. This
 * function verifies the commitment MATCHES and then retires the claimable row
 * (status='revoked', reason='reclaimed') while minting a fresh owner-bound
 * token — rather than mutating the old row's owner in place.
 *
 * Why retire-and-reissue instead of update: the claim secret was, by
 * construction, held by whoever completed the wallet-less signup. Rotating the
 * token at claim time means the new owner's token was never known to anyone in
 * the pre-claim state, including us.
 *
 * NOTE: the caller supplies the recomputed commitment; verifying the ZK preimage
 * proof itself is the caller's job (routes layer), because the proof system is
 * chosen there. This function will not accept a claim whose commitment does not
 * match an active claimable row.
 */
export async function reclaim(params: {
  claimCommitment: string;
  owner: TokenOwner;
  repidAgentId?: string | null;
}): Promise<MintResult> {
  if (!IDENTITY_TOKENS_ENABLED) {
    return { ok: false, reason: 'disabled', detail: 'Identity token issuance is not enabled on this deployment.' };
  }
  const c = String(params.claimCommitment ?? '').trim().toLowerCase();
  const { data: existing } = await db
    .from('hdg_identity_tokens')
    .select('id, owner_kind, status')
    .eq('claim_commitment', c)
    .eq('status', 'active')
    .maybeSingle();

  if (!existing || existing.owner_kind !== 'claimable') {
    return { ok: false, reason: 'bad_request', detail: 'No live claimable token for that commitment.' };
  }

  const minted = await mintForOwner({ owner: params.owner, repidAgentId: params.repidAgentId, label: 'reclaimed' });
  if (!minted.ok) return minted;

  // Retire the claimable row only AFTER the replacement exists, so a failure
  // between the two leaves the holder with a working token rather than none.
  await db
    .from('hdg_identity_tokens')
    .update({ status: 'revoked', revoked_at: new Date().toISOString(), revoke_reason: 'reclaimed', claimed_at: new Date().toISOString() })
    .eq('id', existing.id);

  return { ...minted, detail: 'Claimed. The pre-claim token is retired; this one is bound to your wallet.' };
}

/**
 * Revoke a token.
 *
 * Sets status + revoked_at; never deletes. The rate limiter's 60s cache means a
 * revoked token can still bypass for up to a minute — stated here rather than
 * discovered later. Historical attribution stays readable: runs already credited
 * to this token's RepID are unaffected, which is the correct semantics. Future
 * capability stops; past facts remain true.
 */
export async function revokeToken(params: { id: string; owner: TokenOwner; reason?: string }) {
  const { data, error } = await db
    .from('hdg_identity_tokens')
    .update({ status: 'revoked', revoked_at: new Date().toISOString(), revoke_reason: params.reason ?? 'user_revoked' })
    .eq('id', params.id)
    .eq('owner_id', params.owner.id)
    .eq('status', 'active')
    .select('id, key_prefix, status, revoked_at')
    .maybeSingle();
  if (error) return { ok: false, detail: error.message };
  if (!data) return { ok: false, detail: 'No active token with that id for this owner.' };
  return { ok: true, detail: 'Revoked. Rate-limit bypass may persist up to 60s while the validator cache expires.', record: data };
}

/** List an owner's tokens. Prefixes only — the secrets are not stored. */
export async function listTokens(owner: TokenOwner) {
  const { data } = await db
    .from('hdg_identity_tokens')
    .select('id, key_prefix, owner_kind, repid_agent_id, status, label, usage_count, last_used_at, created_at, revoked_at, revoke_reason')
    .eq('owner_id', owner.id)
    .order('created_at', { ascending: false });
  return data ?? [];
}
