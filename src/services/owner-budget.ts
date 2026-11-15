/**
 * OWNER BUDGET: every agent bound to one owner spends against ONE budget, the owner's funded stake.
 *
 * Before this, each agent's cap was its own USDC approval (agent-spend.ts), so N agents of one
 * owner could each spend up to the whole stake. The invariant now, per owner:
 *
 *     reserved + settled + unknown  <=  funded stake
 *
 * It is held in Postgres (supabase/migrations/20261114200000_owner_spend_ledger.sql), not here:
 * `reserve_owner_spend` takes a per-owner advisory lock, reads both sums and inserts the
 * reservation in one transaction, so concurrent spends by different agents of one owner, on any
 * number of replicas, cannot both pass. This file only calls it.
 *
 * The spend route reserves BEFORE it signs, then settles on a receipt with status 1, releases on a
 * receipt with status 0 (reverted: no USDC moved), and marks `unknown` when the send threw, because
 * then the transfer may have landed. `unknown` keeps counting until someone reconciles it against
 * the chain. Releasing on a guess would let a budget be spent twice.
 *
 * OWNER_BUDGET_MODE (default off):
 *   off      nothing here runs.
 *   shadow   never refuses. Logs when it WOULD refuse, and records each settled spend so the
 *            ledger is complete when enforcement starts.
 *   enforce  refuses over-budget spends, and refuses (503) when the ledger cannot be read.
 * An unrecognised value enforces and says so loudly: a typo in a money control fails closed.
 */
import { db } from '../db';

export type OwnerBudgetMode = 'off' | 'shadow' | 'enforce';

export function ownerBudgetMode(raw: string | undefined = process.env.OWNER_BUDGET_MODE): OwnerBudgetMode {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return 'off';
  if (v === 'shadow' || v === 'enforce') return v;
  console.error(`[owner-budget] OWNER_BUDGET_MODE=${JSON.stringify(raw)} is not off, shadow or enforce: enforcing (fail closed).`);
  return 'enforce';
}

export interface Reservation {
  ok: boolean;
  id: string | null;
  /** Funded stake, micro-USDC. */
  budget: bigint;
  /** Reserved + settled + unknown, micro-USDC; after this reservation when ok. */
  committed: bigint;
}

export type FinishState = 'settled' | 'released' | 'unknown';

export interface OwnerBudgetStore {
  reserve(builderId: string, agentId: string, amount: bigint): Promise<Reservation>;
  /** Moves a reservation out of `reserved`. Throws if the write fails. */
  finish(id: string, state: FinishState, txHash: string | null, reason: string): Promise<void>;
  /** Read-only: for dry runs and shadow mode. */
  status(builderId: string): Promise<{ budget: bigint; committed: bigint }>;
  /** Shadow mode: a spend that went through without a reservation. */
  recordSettled(builderId: string, agentId: string, amount: bigint, txHash: string): Promise<void>;
  /**
   * Start a real stake withdrawal BEFORE its refund (begin_stake_withdrawal): under the per-owner
   * lock, refuse unless funded - amount still covers committed agent spend, else write the pending
   * debit row and return its id. That row is the hold and the refund record at once. Throws on failure.
   */
  beginWithdrawal(builderId: string, amount: bigint): Promise<{ ok: boolean; debitId: string | null; funded: bigint; committed: bigint }>;
}

const big = (v: unknown): bigint => BigInt(String(v ?? 0));

export const supabaseOwnerBudget: OwnerBudgetStore = {
  async reserve(builderId, agentId, amount) {
    const { data, error } = await db.rpc('reserve_owner_spend', {
      p_builder: builderId,
      p_agent: agentId,
      p_amount: amount.toString(),
    });
    if (error) throw new Error(`reserve_owner_spend failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('reserve_owner_spend returned no row');
    return { ok: row.ok === true, id: row.reservation_id ?? null, budget: big(row.budget), committed: big(row.committed) };
  },

  async finish(id, state, txHash, reason) {
    const { data, error } = await db
      .from('owner_spend_ledger')
      .update({ state, tx_hash: txHash, reason: reason.slice(0, 500), updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('state', 'reserved')
      .select('id');
    if (error) throw new Error(`owner_spend_ledger finish failed: ${error.message}`);
    if (!data || data.length !== 1) throw new Error(`owner_spend_ledger finish: reservation ${id} was not in state reserved`);
  },

  async status(builderId) {
    const [funded, open] = await Promise.all([
      db.rpc('owner_funded_stake', { p_builder: builderId }),
      db.from('owner_spend_ledger').select('amount').eq('builder_id', builderId).neq('state', 'released'),
    ]);
    if (funded.error) throw new Error(`owner_funded_stake failed: ${funded.error.message}`);
    if (open.error) throw new Error(`owner_spend_ledger read failed: ${open.error.message}`);
    const committed = (open.data ?? []).reduce((acc: bigint, r: any) => acc + big(r.amount), 0n);
    return { budget: big(funded.data), committed };
  },

  async recordSettled(builderId, agentId, amount, txHash) {
    const { error } = await db.from('owner_spend_ledger').insert({
      builder_id: builderId,
      agent_id: agentId,
      amount: amount.toString(),
      state: 'settled',
      tx_hash: txHash,
      reason: 'shadow: settled without a reservation',
    });
    if (error) throw new Error(`owner_spend_ledger insert failed: ${error.message}`);
  },

  async beginWithdrawal(builderId, amount) {
    const { data, error } = await db.rpc('begin_stake_withdrawal', { p_builder: builderId, p_amount: amount.toString() });
    if (error) throw new Error(`begin_stake_withdrawal failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('begin_stake_withdrawal returned no row');
    return { ok: row.ok === true, debitId: row.debit_id ?? null, funded: big(row.funded), committed: big(row.committed) };
  },
};

/**
 * AGENT SPEND LIMITS (AGENT_SPEND_SOURCE=stake; supabase/migrations/20261115120000_agent_spend_limits.sql).
 * An agent spends from its owner's stake only up to a limit the owner SIGNED (owner-authorization
 * action `spend.limit`): the binding grants no spending authority, and the agent's API key alone
 * must not be able to move the stake (Strix on #1551). The latest limit covers the agent's spends
 * reserved since it was set; no limit means no spending from stake.
 */
export type AgentLimitRefusal = 'no_spend_limit' | 'over_agent_limit' | 'over_owner_budget';

export interface AgentLimitReservation extends Reservation {
  /** Why it was refused, or null when ok. */
  reason: AgentLimitRefusal | null;
  /** Micro-USDC; null when the owner has set no limit for this agent. */
  agentLimit: bigint | null;
  /** This agent's reserved + settled + unknown since its limit was set; after this one when ok. */
  agentCommitted: bigint;
}

export interface AgentLimitStore {
  /** reserve_agent_stake_spend: the agent's limit, then the owner's budget, under the owner lock. Throws on failure. */
  reserve(builderId: string, agentId: string, amount: bigint): Promise<AgentLimitReservation>;
  /** Read-only, for dry runs. Throws on failure. */
  status(builderId: string, agentId: string): Promise<{ agentLimit: bigint | null; agentCommitted: bigint }>;
  /** Record a new limit (the caller has already checked the owner's signature, or the limit is 0). Throws on failure. */
  set(builderId: string, agentId: string, limit: bigint, setBy: string): Promise<void>;
}

const REFUSALS = new Set<string>(['no_spend_limit', 'over_agent_limit', 'over_owner_budget']);

export const supabaseAgentLimits: AgentLimitStore = {
  async reserve(builderId, agentId, amount) {
    const { data, error } = await db.rpc('reserve_agent_stake_spend', { p_builder: builderId, p_agent: agentId, p_amount: amount.toString() });
    if (error) throw new Error(`reserve_agent_stake_spend failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('reserve_agent_stake_spend returned no row');
    const ok = row.ok === true;
    // A refusal must name one of the reasons this code knows, or it is not an answer we can act on.
    if (!ok && !REFUSALS.has(String(row.reason))) throw new Error(`reserve_agent_stake_spend refused with an unknown reason: ${String(row.reason)}`);
    return {
      ok,
      id: row.reservation_id ?? null,
      reason: ok ? null : (row.reason as AgentLimitRefusal),
      budget: big(row.budget),
      committed: big(row.committed),
      agentLimit: row.agent_limit === null || row.agent_limit === undefined ? null : big(row.agent_limit),
      agentCommitted: big(row.agent_committed),
    };
  },

  async status(builderId, agentId) {
    const { data: lim, error: lErr } = await db
      .from('agent_spend_limits')
      .select('limit_amount, set_at')
      .eq('builder_id', builderId)
      .eq('agent_id', agentId)
      .order('set_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lErr) throw new Error(`agent_spend_limits read failed: ${lErr.message}`);
    if (!lim) return { agentLimit: null, agentCommitted: 0n };
    const { data: rows, error } = await db
      .from('owner_spend_ledger')
      .select('amount')
      .eq('builder_id', builderId)
      .eq('agent_id', agentId)
      .neq('state', 'released')
      .gte('created_at', (lim as any).set_at);
    if (error) throw new Error(`owner_spend_ledger read failed: ${error.message}`);
    const agentCommitted = (rows ?? []).reduce((acc: bigint, r: any) => acc + big(r.amount), 0n);
    return { agentLimit: big((lim as any).limit_amount), agentCommitted };
  },

  async set(builderId, agentId, limit, setBy) {
    const { error } = await db.from('agent_spend_limits').insert({ builder_id: builderId, agent_id: agentId, limit_amount: limit.toString(), set_by: setBy });
    if (error) throw new Error(`agent_spend_limits insert failed: ${error.message}`);
  },
};

/** The owner's account (builder) for an agent, or null when the owner is not a builder account. */
export async function ownerBuilderOfAgent(agentId: string): Promise<string | null> {
  const { ownerOfAgent } = require('./human-agent-binding') as typeof import('./human-agent-binding');
  const owner = await ownerOfAgent(agentId);
  return owner && owner.owner_kind === 'builder' && owner.builder_id ? String(owner.builder_id) : null;
}
