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
};

/** The owner's account (builder) for an agent, or null when the owner is not a builder account. */
export async function ownerBuilderOfAgent(agentId: string): Promise<string | null> {
  const { ownerOfAgent } = require('./human-agent-binding') as typeof import('./human-agent-binding');
  const owner = await ownerOfAgent(agentId);
  return owner && owner.owner_kind === 'builder' && owner.builder_id ? String(owner.builder_id) : null;
}
