/**
 * human-agent-binding.ts — make an agent somebody's.
 *
 * Until now there has been no "your agent". `human_sbt_registry` records that a
 * human was verified, `repid_agents` records that an agent exists, and nothing
 * joins them. Every story we want to tell — your agent, your reputation, your
 * keys, guardrails you chose — needs an owner first.
 *
 * WHAT A BINDING HAS TO SURVIVE. Ownership that anyone can assert is not
 * ownership, so a bind requires a signature from the wallet the human is
 * registered under, over a message naming this exact agent. A stolen or replayed
 * signature from one agent cannot bind another, because the agent id is inside
 * the signed text.
 *
 * ONE LIVE OWNER. Enforced in the database by a partial unique index on
 * (agent_id, scope) WHERE revoked_at IS NULL, not just here — ownership that can
 * fork under a race is not ownership either.
 *
 * DESIGNED SO THE ZK VERSION FITS LATER (ZKP_ARCHITECTURE_INVARIANTS):
 *   inv 2 — `scope` is a COLUMN, never hardcoded to 'ownership', so the same
 *           identity can later prove consent in another scope without a second
 *           identity system.
 *   inv 3 — `domain` is carried so the eventual on-chain verifier is
 *           domain-parameterised rather than ownership-specific.
 *   inv 6 — the same namespacing the circuit registry uses.
 * `nullifier` is null today. When the anonymous proof lands it fills in, and no
 * live row has to be reshaped. This is keeping the door open, NOT building it.
 *
 * TWO SIDES, NOT ONE [2026-10-07]. Until this date a bind proved only the WALLET:
 * the agent check was "does this agent id exist". So the first wallet to claim an
 * unclaimed agent became its owner — anyone's agent, a house agent, an agent
 * created a minute ago in someone else's browser — and the partial unique index
 * then locked the real creator out. Production had the flag on with zero bindings,
 * so the hole was open and unused. Now a bind also needs the agent's OWN key (the
 * one handed to whoever created it, held in their browser or `.trustshell/`), so a
 * binding says both "this wallet is mine" and "this agent is mine".
 *
 * SMART WALLETS. The wallet signature is checked by wallet-signature.ts, which
 * accepts passkey/contract wallets (ERC-1271, and ERC-6492 before their first
 * transaction) as well as plain key-pair wallets. If the chain cannot be reached to
 * check a contract wallet, the answer is `signature_not_checked`, never
 * `bad_signature`.
 *
 * FLAG: HUMAN_AGENT_BIND_ENABLED (default OFF) — original work touching live
 * state, so it lands finished-and-inert per CLAUDE_RULES 23.
 */
import { verifyMessage } from 'ethers';
import { db } from '../db';
import { validateAgentApiKey } from '../auth/api-keys';
import { verifyWalletMessage } from './wallet-signature';

export const HUMAN_AGENT_BIND_ENABLED = process.env.HUMAN_AGENT_BIND_ENABLED === 'true';

/** Default ownership scope. A parameter, deliberately — see invariant 2. */
export const SCOPE_OWNERSHIP = 'ownership';
export const DOMAIN_IDENTITY = 'identity';

/**
 * WHO can own, and HOW STRONGLY that was established.
 *
 * The first version of this required a proof-of-human SBT. The live numbers said
 * that was wrong: 73 builders (every one wallet-bearing) against 5 SBT humans,
 * so ownership was unreachable for ~94% of real accounts — and it duplicated
 * repid_agents.builder_id, which 43 agents already carry.
 *
 * The fix is NOT to let an email count as proof of humanity. It is to record
 * which kind of owner this is and let every surface state it, so a strong claim
 * is never made on weak evidence:
 *
 *   builder    a wallet whose control was PROVEN by signature. Self-serve, and
 *              what a viewer following the video will have. Proves someone holds
 *              that key — not that they are a distinct human.
 *   human_sbt  additionally passed proof-of-human. Strictly stronger.
 *
 * Distinct from `repid_agents.builder_id`, which is an administrative link that
 * nobody signed. A binding is a CLAIM SOMEONE MADE AND PROVED, and can be
 * revoked. Both can exist; only one of them is evidence.
 */
export type OwnerKind = 'builder' | 'human_sbt';

export interface OwnerRef {
  kind: OwnerKind;
  /** builders.id for a builder, human_sbt_registry.token_id for an SBT human. */
  id: string;
  wallet?: string;
}

/** Plain-language assurance, for receipts and UI. Never collapses the two levels. */
export function assuranceOf(kind: OwnerKind): { level: OwnerKind; label: string; means: string } {
  return kind === 'human_sbt'
    ? {
        level: 'human_sbt',
        label: 'proof-of-human',
        means: 'The owner passed human verification and proved control of their wallet.',
      }
    : {
        level: 'builder',
        label: 'wallet-proven',
        means: 'The owner proved control of this wallet by signature. That is not a proof they are a distinct human.',
      };
}

export interface BindResult {
  ok: boolean;
  reason?:
    | 'disabled'
    | 'human_not_verified'
    | 'agent_not_found'
    | 'already_bound'
    | 'bad_signature'
    | 'signature_not_checked'
    | 'agent_key_required'
    | 'agent_key_mismatch'
    | 'write_failed';
  detail: string;
  binding?: {
    agent_id: string;
    owner_kind: OwnerKind;
    human_token_id: string | null;
    builder_id: string | null;
    scope: string;
    bound_at: string;
  };
}

/**
 * The exact text the human signs. Stable, human-readable, and specific.
 *
 * The agent id is INSIDE the message, so a signature captured for one agent
 * cannot be replayed to claim another. The wallet is in there too, so a
 * signature cannot be presented on behalf of a different address.
 */
export function bindingMessage(params: { wallet: string; agentId: string; scope: string }): string {
  return [
    'HyperDAG — bind agent to human',
    '',
    `wallet: ${params.wallet.toLowerCase()}`,
    `agent:  ${params.agentId}`,
    `scope:  ${params.scope}`,
    '',
    'Signing this proves you control this wallet and claims ownership of this agent.',
    'It moves no funds and grants no spending authority.',
  ].join('\n');
}

/**
 * Recover the signer and compare. Returns false on any malformed input.
 * Plain key-pair wallets only; the bind path uses verifyWalletMessage, which also
 * accepts smart wallets. Kept for its existing callers.
 */
export function signatureMatches(wallet: string, message: string, signature: string): boolean {
  try {
    return verifyMessage(message, signature).toLowerCase() === wallet.toLowerCase();
  } catch {
    return false;
  }
}

export async function bindOwnerToAgent(params: {
  owner: OwnerRef;
  agentId: string;
  signature?: string;
  scope?: string;
  /**
   * The agent's own API key — the second side of the bind. Whoever created the
   * agent was handed it once; a wallet alone proves nothing about the agent.
   */
  agentKey?: string;
  /** Skips both proofs. ONLY for tests and operator backfill. */
  trustedCaller?: boolean;
}): Promise<BindResult> {
  const scope = params.scope ?? SCOPE_OWNERSHIP;
  if (!HUMAN_AGENT_BIND_ENABLED) {
    return { ok: false, reason: 'disabled', detail: 'Ownership binding is not enabled on this deployment.' };
  }

  // Resolve the owner against whichever registry actually holds them, and take
  // the wallet FROM THAT ROW — never from the caller, who could otherwise name a
  // wallet they happen to control and bind on someone else's account.
  let wallet: string | null = null;
  if (params.owner.kind === 'human_sbt') {
    const { data } = await db
      .from('human_sbt_registry')
      .select('token_id, wallet_address')
      .eq('token_id', params.owner.id)
      .maybeSingle();
    if (!data) {
      return { ok: false, reason: 'human_not_verified', detail: 'No verified human is registered under that token.' };
    }
    wallet = data.wallet_address ?? null;
  } else {
    const { data } = await db.from('builders').select('id, address').eq('id', params.owner.id).maybeSingle();
    if (!data) {
      return { ok: false, reason: 'human_not_verified', detail: 'No account found. Connect a wallet first.' };
    }
    wallet = data.address ?? null;
  }

  const { data: agent } = await db
    .from('repid_agents')
    .select('id, agent_name')
    .eq('id', params.agentId)
    .maybeSingle();
  if (!agent) return { ok: false, reason: 'agent_not_found', detail: 'No such agent.' };

  // Proof of control, BOTH sides. Skipped only for a trusted caller, and the skip is
  // a parameter rather than an env flag so it can never be on by accident in prod.
  if (!params.trustedCaller) {
    // Side one: the agent. Checked first, so a caller who does not hold the agent
    // learns nothing about whether their wallet signature would have passed.
    if (!params.agentKey) {
      return {
        ok: false,
        reason: 'agent_key_required',
        detail: "Binding needs the agent's own key as well as your wallet signature. The key proves the agent is yours; the signature proves the wallet is.",
      };
    }
    let keyAgentId: string | null = null;
    try {
      keyAgentId = (await validateAgentApiKey(params.agentKey))?.agent_id ?? null;
    } catch {
      keyAgentId = null;
    }
    if (!keyAgentId || keyAgentId !== params.agentId) {
      return {
        ok: false,
        reason: 'agent_key_mismatch',
        detail: "That key does not belong to this agent, or has been revoked. Use the key you were given when the agent was created.",
      };
    }

    // Side two: the wallet.
    if (!wallet) {
      return {
        ok: false,
        reason: 'bad_signature',
        detail: 'This account has no wallet on record, so control cannot be proven.',
      };
    }
    const msg = bindingMessage({ wallet, agentId: params.agentId, scope });
    const checked = params.signature
      ? await verifyWalletMessage(wallet, msg, params.signature)
      : ({ ok: false, reason: 'invalid', detail: 'No signature.' } as const);
    if (!checked.ok) {
      return checked.reason === 'not_checked'
        ? {
            ok: false,
            reason: 'signature_not_checked',
            detail: `${checked.detail} Nothing was bound; try again in a moment.`,
          }
        : {
            ok: false,
            reason: 'bad_signature',
            detail: 'Signature did not recover to the wallet on record for this exact agent and scope.',
          };
    }
  }

  const { data, error } = await db
    .from('human_agent_bindings')
    .insert({
      owner_kind: params.owner.kind,
      // The CHECK constraint permits exactly one of these to be set.
      human_token_id: params.owner.kind === 'human_sbt' ? params.owner.id : null,
      builder_id: params.owner.kind === 'builder' ? params.owner.id : null,
      human_wallet: wallet,
      agent_id: params.agentId,
      scope,
      domain: DOMAIN_IDENTITY,
      binding_sig: params.signature ?? null,
    })
    .select('agent_id, owner_kind, human_token_id, builder_id, scope, bound_at')
    .maybeSingle();

  if (error) {
    // 23505 = the partial unique index refusing a second live owner. That is the
    // rule working, so it is reported as such rather than as a database error.
    const alreadyBound = /duplicate key|23505/i.test(error.message ?? '');
    return {
      ok: false,
      reason: alreadyBound ? 'already_bound' : 'write_failed',
      detail: alreadyBound
        ? 'This agent already has a live owner in this scope. Revoke the existing binding first.'
        : error.message,
    };
  }
  if (!data) return { ok: false, reason: 'write_failed', detail: 'insert returned no row' };

  return { ok: true, detail: `Bound to ${agent.agent_name ?? params.agentId}.`, binding: data };
}

export async function revokeBinding(agentId: string, scope = SCOPE_OWNERSHIP, reason = 'user_revoked') {
  const { error } = await db
    .from('human_agent_bindings')
    .update({ revoked_at: new Date().toISOString(), revoke_reason: reason })
    .eq('agent_id', agentId)
    .eq('scope', scope)
    .is('revoked_at', null);
  return { ok: !error, detail: error?.message ?? 'revoked' };
}

/**
 * Who owns this agent right now, if anyone — and on what evidence.
 *
 * Returns the assurance level alongside the owner so no caller has to guess,
 * and so a wallet-proven owner is never rendered as "verified human".
 */
export async function ownerOfAgent(agentId: string, scope = SCOPE_OWNERSHIP) {
  const { data, error } = await db
    .from('human_agent_bindings')
    .select('owner_kind, human_token_id, builder_id, human_wallet, scope, bound_at')
    .eq('agent_id', agentId)
    .eq('scope', scope)
    .is('revoked_at', null)
    .maybeSingle();
  // [F1] A failed read is not "nobody owns it". Callers that widen on "no owner" would otherwise
  // fail open on a database blip, so the error propagates and each route answers 503.
  if (error) throw new Error(`owner lookup failed: ${error.message}`);
  if (!data) return null;
  const kind = (data.owner_kind ?? 'human_sbt') as OwnerKind;
  return {
    ...data,
    owner_id: kind === 'builder' ? data.builder_id : data.human_token_id,
    assurance: assuranceOf(kind),
  };
}

const AGENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Callers name agents by id (what an agent-bound key must send) or by name (older callers). */
export function agentRefColumn(ref: string): 'id' | 'agent_name' {
  return AGENT_UUID.test(ref) ? 'id' : 'agent_name';
}

/**
 * The bound owner of an agent named by id or by name, for routes that must ask the owner before
 * widening what the agent may do. Names are NOT unique (13 case-collisions measured 2026-10-07), so
 * a name that matches more than one agent, any of them owned, is `ambiguous`: the caller must use
 * the id rather than have us guess whose owner to ask.
 */
export async function boundOwnerOfRef(
  ref: string,
): Promise<{ agentId: string; wallet: string } | null | 'ambiguous'> {
  let ids: string[];
  if (agentRefColumn(ref) === 'id') {
    ids = [ref];
  } else {
    const { data } = await db.from('repid_agents').select('id').eq('agent_name', ref);
    ids = ((data as Array<{ id: string }> | null) ?? []).map((r) => r.id);
  }
  const owned: Array<{ agentId: string; wallet: string }> = [];
  for (const id of ids) {
    const o = await ownerOfAgent(id);
    if (o?.human_wallet) owned.push({ agentId: id, wallet: o.human_wallet as string });
  }
  if (owned.length === 0) return null;
  if (ids.length > 1) return 'ambiguous';
  return owned[0]!;
}

/** Every agent this owner owns — the "my team of experts" list. */
export async function agentsOfOwner(owner: OwnerRef, scope = SCOPE_OWNERSHIP) {
  const col = owner.kind === 'builder' ? 'builder_id' : 'human_token_id';
  const { data } = await db
    .from('human_agent_bindings')
    .select('agent_id, owner_kind, scope, bound_at')
    .eq(col, owner.id)
    .eq('scope', scope)
    .is('revoked_at', null)
    .order('bound_at');
  return data ?? [];
}

/**
 * The administrative link that is NOT proof. repid_agents.builder_id is set by
 * whatever created the agent; nobody signed it. Surfaced separately so a UI can
 * say "linked to this account, ownership not yet claimed" instead of implying a
 * proof that does not exist — and so a viewer can see the difference the moment
 * they sign.
 */
export async function linkedButUnbound(agentId: string): Promise<{ builder_id: string | null; is_proven: boolean }> {
  const { data: agent } = await db.from('repid_agents').select('builder_id').eq('id', agentId).maybeSingle();
  const owner = await ownerOfAgent(agentId);
  return { builder_id: agent?.builder_id ?? null, is_proven: !!owner };
}
