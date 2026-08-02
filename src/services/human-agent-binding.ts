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
 * FLAG: HUMAN_AGENT_BIND_ENABLED (default OFF) — original work touching live
 * state, so it lands finished-and-inert per CLAUDE_RULES 23.
 */
import { verifyMessage } from 'ethers';
import { db } from '../db';

export const HUMAN_AGENT_BIND_ENABLED = process.env.HUMAN_AGENT_BIND_ENABLED === 'true';

/** Default ownership scope. A parameter, deliberately — see invariant 2. */
export const SCOPE_OWNERSHIP = 'ownership';
export const DOMAIN_IDENTITY = 'identity';

export interface BindResult {
  ok: boolean;
  reason?:
    | 'disabled'
    | 'human_not_verified'
    | 'agent_not_found'
    | 'already_bound'
    | 'bad_signature'
    | 'write_failed';
  detail: string;
  binding?: { agent_id: string; human_token_id: string; scope: string; bound_at: string };
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

/** Recover the signer and compare. Returns false on any malformed input. */
export function signatureMatches(wallet: string, message: string, signature: string): boolean {
  try {
    return verifyMessage(message, signature).toLowerCase() === wallet.toLowerCase();
  } catch {
    return false;
  }
}

export async function bindHumanToAgent(params: {
  humanTokenId: string;
  agentId: string;
  signature?: string;
  scope?: string;
  /** Skips signature checking. ONLY for tests and operator backfill. */
  trustedCaller?: boolean;
}): Promise<BindResult> {
  const scope = params.scope ?? SCOPE_OWNERSHIP;
  if (!HUMAN_AGENT_BIND_ENABLED) {
    return { ok: false, reason: 'disabled', detail: 'Human↔agent binding is not enabled on this deployment.' };
  }

  const { data: human } = await db
    .from('human_sbt_registry')
    .select('token_id, wallet_address, qualification_tier')
    .eq('token_id', params.humanTokenId)
    .maybeSingle();
  if (!human) {
    return {
      ok: false,
      reason: 'human_not_verified',
      detail: 'No verified human is registered under that token. Complete human verification first.',
    };
  }

  const { data: agent } = await db
    .from('repid_agents')
    .select('id, agent_name')
    .eq('id', params.agentId)
    .maybeSingle();
  if (!agent) return { ok: false, reason: 'agent_not_found', detail: 'No such agent.' };

  // Proof of control. Skipped only for a trusted caller, and the skip is a
  // parameter rather than an env flag so it can never be on by accident in prod.
  if (!params.trustedCaller) {
    const wallet = human.wallet_address;
    if (!wallet) {
      return {
        ok: false,
        reason: 'bad_signature',
        detail: 'This human has no wallet on record, so control cannot be proven.',
      };
    }
    const msg = bindingMessage({ wallet, agentId: params.agentId, scope });
    if (!params.signature || !signatureMatches(wallet, msg, params.signature)) {
      return {
        ok: false,
        reason: 'bad_signature',
        detail: 'Signature did not recover to the registered wallet for this exact agent and scope.',
      };
    }
  }

  const { data, error } = await db
    .from('human_agent_bindings')
    .insert({
      human_token_id: human.token_id,
      human_wallet: human.wallet_address ?? null,
      agent_id: params.agentId,
      scope,
      domain: DOMAIN_IDENTITY,
      binding_sig: params.signature ?? null,
    })
    .select('agent_id, human_token_id, scope, bound_at')
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

/** Who owns this agent right now, if anyone. */
export async function ownerOfAgent(agentId: string, scope = SCOPE_OWNERSHIP) {
  const { data } = await db
    .from('human_agent_bindings')
    .select('human_token_id, human_wallet, scope, bound_at')
    .eq('agent_id', agentId)
    .eq('scope', scope)
    .is('revoked_at', null)
    .maybeSingle();
  return data ?? null;
}

/** Every agent this human owns — the "my team of experts" list. */
export async function agentsOfHuman(humanTokenId: string, scope = SCOPE_OWNERSHIP) {
  const { data } = await db
    .from('human_agent_bindings')
    .select('agent_id, scope, bound_at')
    .eq('human_token_id', humanTokenId)
    .eq('scope', scope)
    .is('revoked_at', null)
    .order('bound_at');
  return data ?? [];
}
