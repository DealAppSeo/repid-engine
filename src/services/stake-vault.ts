/**
 * Stake vault — reponomics quadratic authority engine.
 *
 * Stake math (from sprint Phase 3):
 *   combinedScore = (R * W * C) / 1_000_000        // scales to ~[0, 40000]
 *   stakeSqrt     = babylonianSqrt(stakeAmount)    // integer sqrt
 *   authority     = stakeSqrt * combinedScore / 10_000n
 *
 * Floor protection: builder.current_repid < 5000 ⇒ authority = 0n.
 *
 * Withdrawals are blocked while the builder has open linked_bets
 * (one-way valve: the bet must resolve before the stake can move).
 */

import { db } from '../db';
import { emitAuditEvent } from './audit-emit';
import { BUILDER_FLOOR, computeAuthority, babylonianSqrt } from './authority-math';
import { recordSponsorship } from './sponsorship'; // R3 exercise + GA handoff

export { BUILDER_FLOOR, computeAuthority };

// ---------------------------------------------------------------------------
// DB-backed operations
// ---------------------------------------------------------------------------

export interface DepositResult {
  ok: boolean;
  builder_id: string;
  total_active_stake: string;
  authority_after: string;
  is_simulated: boolean;
  error?: string;
}

export async function depositStake(
  builderAddress: string,
  amount: bigint,
  txHash?: string,
): Promise<DepositResult> {
  const lower = builderAddress.toLowerCase();
  const { data: builder, error: bErr } = await db
    .from('builders')
    .select('id, current_repid')
    .ilike('address', lower)
    .maybeSingle();
  if (bErr || !builder) {
    return { ok: false, builder_id: '', total_active_stake: '0', authority_after: '0', is_simulated: true, error: 'builder not found' };
  }

  const { error: insErr } = await db.from('stake_deposits').insert({
    builder_id: builder.id,
    amount: amount.toString(),
    status: 'active',
    is_simulated: !process.env.X402_REAL_RPC,
    deposit_tx_hash: txHash ?? `simulated:deposit:${Date.now()}`,
  });
  if (insErr) {
    return { ok: false, builder_id: builder.id, total_active_stake: '0', authority_after: '0', is_simulated: true, error: insErr.message };
  }

  // R3/R4: also write to agent_stakes for substrate exercise >N=1 (GA dashboard visible)
  // Fixed: cast for supabase builder (not native promise); fire-and-forget non-blocking
  (db.from('agent_stakes').insert({
    staker_agent: builder.id,
    stake_amount: Number(amount) / 1_000_000,
    dimension: 'builder_stake',
    status: 'active',
    target_model: 'general'
  }) as any).then(() => {}).catch(() => {});

  const total = await getCurrentStake(builder.id);
  const auth = await snapshotAuthority(builder.id, total);

  await emitAuditEvent({
    event_type: 'stake_deposit',
    source_table: 'stake_deposits',
    source_id: `deposit-${builder.id}-${Date.now()}`,
    payload: {
      builder_id: builder.id,
      amount: amount.toString(),
      total_active_stake: total.toString(),
      authority_after: auth.authority.toString(),
      is_simulated: !process.env.X402_REAL_RPC,
    },
  });

  return {
    ok: true,
    builder_id: builder.id,
    total_active_stake: total.toString(),
    authority_after: auth.authority.toString(),
    is_simulated: !process.env.X402_REAL_RPC,
  };
}

export interface WithdrawResult {
  ok: boolean;
  total_active_stake: string;
  authority_after: string;
  error?: string;
}

export async function withdrawStake(builderId: string, amount: bigint): Promise<WithdrawResult> {
  // Block if any agent under this builder has open bets.
  const { data: openBets } = await db
    .from('linked_bets')
    .select('id, agent_id, repid_agents!inner(builder_id)')
    .eq('status', 'open')
    .eq('repid_agents.builder_id', builderId)
    .limit(1);
  if (openBets && openBets.length > 0) {
    return { ok: false, total_active_stake: '0', authority_after: '0', error: 'cannot withdraw with open bets' };
  }

  const total = await getCurrentStake(builderId);
  if (amount > total) {
    return { ok: false, total_active_stake: total.toString(), authority_after: '0', error: 'amount exceeds active stake' };
  }

  await db.from('stake_deposits').insert({
    builder_id: builderId,
    amount: (-amount).toString(),
    status: 'withdrawn',
    is_simulated: !process.env.X402_REAL_RPC,
    deposit_tx_hash: `simulated:withdraw:${Date.now()}`,
  });

  const newTotal = await getCurrentStake(builderId);
  const auth = await snapshotAuthority(builderId, newTotal);
  return { ok: true, total_active_stake: newTotal.toString(), authority_after: auth.authority.toString() };
}

export async function getCurrentStake(builderId: string): Promise<bigint> {
  const { data } = await db
    .from('stake_deposits')
    .select('amount')
    .eq('builder_id', builderId);
  if (!data) return 0n;
  return data.reduce((acc, r) => acc + BigInt(r.amount), 0n);
}

// ---------------------------------------------------------------------------
// Snapshot — recomputes authority for a builder using their owned-agent
// roster. Used by the demo timeline + on every deposit/withdraw.
// ---------------------------------------------------------------------------

export interface SnapshotResult {
  authority: bigint;
  basis: {
    stake: string;
    stake_sqrt: string;
    builder_repid: number;
    agents: Array<{ id: string; name: string; current_repid: number; wisdom_score: number; character_score: number }>;
    combined_score_used: string;
    floor_passed: boolean;
  };
}

export async function snapshotAuthority(builderId: string, totalStake?: bigint): Promise<SnapshotResult> {
  const stake = totalStake ?? await getCurrentStake(builderId);

  const { data: builder } = await db
    .from('builders')
    .select('id, current_repid, auth_method')
    .eq('id', builderId)
    .single();
  const builderRepId = Number(builder?.current_repid ?? 0);

  const { data: agents } = await db
    .from('repid_agents')
    .select('id, agent_name, current_repid, wisdom_score, character_score, last_active_at')
    .eq('builder_id', builderId);

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const active = (agents ?? []).filter(a => {
    const ts = a.last_active_at ? new Date(a.last_active_at).getTime() : Date.now();
    return ts > sevenDaysAgo;
  });
  const meanR = active.length > 0
    ? Math.round(active.reduce((s, a) => s + Number(a.current_repid ?? 0), 0) / active.length)
    : 0;
  const meanW = active.length > 0
    ? Math.round(active.reduce((s, a) => s + Number(a.wisdom_score ?? 1000), 0) / active.length)
    : 1000;
  const meanC = active.length > 0
    ? Math.round(active.reduce((s, a) => s + Number(a.character_score ?? 1000), 0) / active.length)
    : 1000;

  const isDemoBuilder = builder?.auth_method === 'token_only';

  const auth = computeAuthority({
    stakeAmount: stake,
    agentRepId: meanR,
    agentWisdom: meanW,
    agentCharacter: meanC,
    builderRepId,
    isDemoBuilder,
  });

  await db.from('stake_authority_snapshots').insert({
    builder_id: builderId,
    computed_authority: auth.authority.toString(),
    basis: {
      stake: stake.toString(),
      stake_sqrt: auth.breakdown.stakeSqrt,
      builder_repid: builderRepId,
      agent_count_active: active.length,
      mean_R: meanR,
      mean_W: meanW,
      mean_C: meanC,
      combined_score_used: auth.breakdown.combinedScore,
      floor_passed: auth.breakdown.builderFloorPassed,
    },
  });

  return {
    authority: auth.authority,
    basis: {
      stake: stake.toString(),
      stake_sqrt: auth.breakdown.stakeSqrt,
      builder_repid: builderRepId,
      agents: (agents ?? []).map(a => ({
        id: a.id,
        name: a.agent_name,
        current_repid: Number(a.current_repid ?? 0),
        wisdom_score: Number(a.wisdom_score ?? 1000),
        character_score: Number(a.character_score ?? 1000),
      })),
      combined_score_used: auth.breakdown.combinedScore,
      floor_passed: auth.breakdown.builderFloorPassed,
    },
  };
}

// R3: clean GA handoff + exercise >N=1. Call recordDeposit multiple times for varied flows.
export async function recordDeposit(agentId: string, amountUsdc: number | bigint, txHash?: string) {
  return depositStake(String(agentId), BigInt(amountUsdc), txHash);
}

export { recordSponsorship } from './sponsorship';
