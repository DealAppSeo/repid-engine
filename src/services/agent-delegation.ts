/**
 * Explicit human → agent authorization (delegations).
 *
 * Today authority is implicit: repid_agents.builder_id links an agent to the human
 * (builders.id) that owns it, and the x402 settlement gate checks tier/stake but never
 * a signed grant. This module makes the grant EXPLICIT and verifiable:
 *
 *   A delegator (human builder) signs an EIP-712 message
 *     "I, <delegator_address>, authorize agent <agent_id> to spend up to <max> until <expiry>"
 *   which is recorded in `agent_delegations` after we verify:
 *     1. the signature recovers to delegator_address, and
 *     2. delegator_address owns the agent (repid_agents.builder_id -> builders.address).
 *
 * Enforcement (`assertDelegationCovers`) is gated behind DELEGATION_REQUIRED (default OFF),
 * so the current implicit behavior is preserved until the flag is turned on.
 *
 * Pure helpers (buildDelegationTypedData, recoverDelegationSigner, decideCoverage) take no DB
 * and are unit-tested without a database; DB-touching fns are thin wrappers over `db`.
 */
import { verifyTypedData, getAddress } from 'ethers';
import { db } from '../db';

// --- EIP-712 domain + types ------------------------------------------------

/**
 * Base Sepolia (chainId 84532) is the canonical chain for HyperDAG attestations
 * (HANDOFF P-024), matching the RepID attestation domain. verifyingContract is the
 * delegation registry placeholder; recovery does not depend on a deployed contract.
 */
export const DELEGATION_DOMAIN = {
  name: 'HyperDAG RepID Delegation',
  version: '1',
  chainId: 84532,
  verifyingContract: '0x0000000000000000000000000000000000000000',
} as const;

/**
 * The signed message. Field names/order are part of the EIP-712 type hash — do not
 * reorder or rename without bumping DELEGATION_DOMAIN.version.
 *   delegator     — human wallet granting authority (must recover from signature)
 *   agent         — agent_name being authorized
 *   maxUsdcPerTx  — per-transaction ceiling, integer USDC
 *   maxUsdcTotal  — cumulative ceiling over the delegation's life, integer USDC
 *   expiry        — unix seconds; delegation is invalid at/after this time
 *   nonce         — replay/uniqueness discriminator chosen by the signer
 */
export const DELEGATION_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Delegation: [
    { name: 'delegator', type: 'address' },
    { name: 'agent', type: 'string' },
    { name: 'maxUsdcPerTx', type: 'uint256' },
    { name: 'maxUsdcTotal', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

export interface DelegationMessage {
  delegator: string;
  agent: string;
  maxUsdcPerTx: number | bigint;
  maxUsdcTotal: number | bigint;
  expiry: number | bigint; // unix seconds
  nonce: number | bigint;
}

/** Return the (domain, types, message) triple an EIP-712 signer needs. Pure. */
export function buildDelegationTypedData(message: DelegationMessage) {
  return { domain: DELEGATION_DOMAIN, types: DELEGATION_TYPES, message };
}

/**
 * Recover the signer of a delegation message. Returns the checksummed address, or null
 * if the signature is malformed / does not recover (never throws). Pure — no DB.
 */
export function recoverDelegationSigner(
  message: DelegationMessage,
  signature: string,
): string | null {
  try {
    return getAddress(verifyTypedData(DELEGATION_DOMAIN, DELEGATION_TYPES, message, signature));
  } catch {
    return null;
  }
}

// --- Coverage decision (pure) ---------------------------------------------

export interface DelegationRow {
  scope_json: { max_usdc_per_tx?: number; max_usdc_total?: number } | null;
  expires_at: string; // ISO
  revoked_at: string | null;
}

export interface CoverageDecision {
  allowed: boolean;
  reason:
    | null
    | 'no_delegation'
    | 'all_revoked'
    | 'all_expired'
    | 'exceeds_per_tx'
    | 'exceeds_total';
}

/**
 * Decide whether ANY of the given delegations covers a requested `amount` (USDC) for the agent,
 * as of `now`. `spentSoFar` is the cumulative authorized spend already recorded against the same
 * delegations (for the max_usdc_total check). Pure — all state injected.
 *
 * A delegation covers the amount iff it is unrevoked, unexpired, amount <= max_usdc_per_tx, and
 * spentSoFar + amount <= max_usdc_total. Precedence of the denial reason is most-specific-last so
 * the caller can surface the closest miss.
 */
export function decideCoverage(
  amount: number,
  delegations: DelegationRow[],
  now: Date = new Date(),
  spentSoFar = 0,
): CoverageDecision {
  if (delegations.length === 0) return { allowed: false, reason: 'no_delegation' };

  const live = delegations.filter((d) => d.revoked_at === null);
  if (live.length === 0) return { allowed: false, reason: 'all_revoked' };

  const unexpired = live.filter((d) => new Date(d.expires_at).getTime() > now.getTime());
  if (unexpired.length === 0) return { allowed: false, reason: 'all_expired' };

  let sawPerTx = false;
  for (const d of unexpired) {
    const perTx = Number(d.scope_json?.max_usdc_per_tx ?? 0);
    const total = Number(d.scope_json?.max_usdc_total ?? 0);
    if (amount > perTx) continue; // this grant is too small per-tx
    sawPerTx = true;
    if (spentSoFar + amount > total) continue; // would blow the cumulative cap
    return { allowed: true, reason: null };
  }
  return { allowed: false, reason: sawPerTx ? 'exceeds_total' : 'exceeds_per_tx' };
}

// --- Ownership + recording (DB) -------------------------------------------

export interface RecordDelegationInput {
  agent: string;
  message: DelegationMessage;
  signature: string;
}

export interface RecordResult {
  ok: boolean;
  id?: string;
  error?:
    | 'bad_signature'
    | 'signer_mismatch'
    | 'agent_not_found'
    | 'not_owner'
    | 'expired'
    | 'db_error';
  recovered?: string | null;
}

/**
 * Verify a signed delegation and, if valid, record it. Rejects when:
 *   - signature does not recover                       -> bad_signature
 *   - recovered address != message.delegator           -> signer_mismatch
 *   - agent has no owning builder                       -> agent_not_found / not_owner
 *   - owning builder's address != delegator             -> not_owner
 *   - expiry already in the past                         -> expired
 */
export async function recordDelegation(input: RecordDelegationInput): Promise<RecordResult> {
  const { agent, message, signature } = input;

  const recovered = recoverDelegationSigner(message, signature);
  if (recovered === null) return { ok: false, error: 'bad_signature', recovered: null };

  let delegator: string;
  try {
    delegator = getAddress(message.delegator);
  } catch {
    return { ok: false, error: 'signer_mismatch', recovered };
  }
  if (recovered.toLowerCase() !== delegator.toLowerCase()) {
    return { ok: false, error: 'signer_mismatch', recovered };
  }

  if (Number(message.expiry) * 1000 <= Date.now()) {
    return { ok: false, error: 'expired', recovered };
  }

  // Ownership: agent -> builder_id -> builders.address must equal delegator.
  const owner = await resolveAgentOwner(agent);
  if (!owner) return { ok: false, error: 'agent_not_found', recovered };
  if (owner.address.toLowerCase() !== delegator.toLowerCase()) {
    return { ok: false, error: 'not_owner', recovered };
  }

  const { data, error } = await db
    .from('agent_delegations')
    .insert({
      delegator_builder_id: owner.builder_id,
      delegator_address: delegator,
      agent_id: agent,
      scope_json: {
        max_usdc_per_tx: Number(message.maxUsdcPerTx),
        max_usdc_total: Number(message.maxUsdcTotal),
      },
      expires_at: new Date(Number(message.expiry) * 1000).toISOString(),
      signature,
    })
    .select('id')
    .single();

  if (error) return { ok: false, error: 'db_error', recovered };
  return { ok: true, id: (data as any)?.id, recovered };
}

export interface OwnerInfo {
  builder_id: string;
  address: string;
}

/** Resolve the human owner of an agent via repid_agents.builder_id -> builders.address. */
export async function resolveAgentOwner(agent: string): Promise<OwnerInfo | null> {
  const { data: agentRow } = await db
    .from('repid_agents')
    .select('builder_id')
    .eq('agent_name', agent)
    .maybeSingle();
  const builderId = (agentRow as any)?.builder_id;
  if (!builderId) return null;

  const { data: builderRow } = await db
    .from('builders')
    .select('address')
    .eq('id', builderId)
    .maybeSingle();
  const address = (builderRow as any)?.address;
  if (!address) return null;

  return { builder_id: builderId, address };
}

export interface RevokeResult {
  ok: boolean;
  revoked: number;
  error?: 'db_error';
}

/**
 * Revoke delegations. If `delegationId` is given, revoke that one; otherwise revoke ALL live
 * delegations for the agent. Idempotent: already-revoked rows are left untouched (revoked_at IS NULL guard).
 */
export async function revokeDelegation(params: {
  agent: string;
  delegationId?: string;
}): Promise<RevokeResult> {
  const now = new Date().toISOString();
  let q = db
    .from('agent_delegations')
    .update({ revoked_at: now })
    .eq('agent_id', params.agent)
    .is('revoked_at', null);
  if (params.delegationId) q = q.eq('id', params.delegationId);

  const { data, error } = await q.select('id');
  if (error) return { ok: false, revoked: 0, error: 'db_error' };
  return { ok: true, revoked: ((data as any[]) ?? []).length };
}

// --- Enforcement hook ------------------------------------------------------

/** DELEGATION_REQUIRED gate. Default OFF preserves the current implicit behavior. */
export function delegationRequired(): boolean {
  return String(process.env['DELEGATION_REQUIRED'] ?? '').toLowerCase() === 'true';
}

export interface DelegationCheck {
  /** true = settlement may proceed (either flag OFF, or a valid delegation covers the amount) */
  allowed: boolean;
  /** true when the flag is on and enforcement actually ran */
  enforced: boolean;
  reason: CoverageDecision['reason'];
}

/**
 * Enforcement hook for the trade/settlement path. When DELEGATION_REQUIRED is OFF this is a no-op
 * that returns { allowed: true, enforced: false } — current behavior is preserved. When ON, it
 * loads the agent's delegations and rejects unless a valid, unexpired, unrevoked delegation covers
 * the requested amount.
 */
export async function assertDelegationCovers(
  agent: string,
  amount: number,
): Promise<DelegationCheck> {
  if (!delegationRequired()) {
    return { allowed: true, enforced: false, reason: null };
  }

  const { data } = await db
    .from('agent_delegations')
    .select('scope_json, expires_at, revoked_at')
    .eq('agent_id', agent);

  const rows = ((data as any[]) ?? []) as DelegationRow[];
  const decision = decideCoverage(amount, rows);
  return { allowed: decision.allowed, enforced: true, reason: decision.reason };
}
