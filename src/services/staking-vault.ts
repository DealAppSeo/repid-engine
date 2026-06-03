/**
 * src/services/staking-vault.ts
 * S-ONCHAIN Phase 2: Staking Vault Interface (MVP writes to DB; later on-chain StakingVault.sol on Base)
 *
 * T12 agents use this for deposits/withdrawals with hold periods, dispute/RepID/HAL gates.
 * Matches the exact interface spec.
 */

import { db } from '../db';

// Exact from spec
export const TIER_HOLD_PERIODS: Record<string, number | null> = {
  PROBATIONARY: null, // can't stake
  EARNING: 14 * 86400, // 14 days in seconds
  ESTABLISHED: 10 * 86400,
  AUTONOMOUS: 7 * 86400,
  VETERAN: 3 * 86400,
};

// SECURITY: Phase 6 hardening - callers must validate input (agent/custodian), apply rate limit (Dragonfly), require auth (custodian sig or API key), and log to hash chain for financial writes.
export async function recordDeposit(
  agentName: string,
  custodianAddress: string,
  amountUsdc: number,
  txHash?: string
) {
  // Validate agent exists
  const { data: agent } = await db
    .from('repid_agents')
    .select('tier')
    .eq('agent_name', agentName)
    .single();

  if (!agent) throw new Error('Agent not found');
  if (agent.tier === 'PROBATIONARY') throw new Error('PROBATIONARY agents cannot stake');

  const holdSeconds = TIER_HOLD_PERIODS[agent.tier] || null;
  const holdUntil = holdSeconds
    ? new Date(Date.now() + holdSeconds * 1000).toISOString()
    : null;

  const { data, error } = await db.from('staking_deposits').insert({
    agent_name: agentName,
    custodian_address: custodianAddress,
    amount_usdc: amountUsdc,
    tx_hash: txHash || null,
    hold_until: holdUntil,
    status: 'active'
  }).select().single();

  if (error) throw new Error(`staking_deposits insert failed: ${error.message}`);
  return data;
}

export async function requestWithdrawal(
  depositId: string,
  agentName: string,
  custodianAddress: string
) {
  // Check for open disputes
  const { count: disputes } = await db
    .from('dispute_claims')
    .select('*', { count: 'exact', head: true })
    .eq('defendant_agent', agentName)
    .in('status', ['filed', 'reviewing']);

  if ((disputes || 0) > 0) {
    return { blocked: true, reason: 'open_dispute', disputeCount: disputes };
  }

  // Check RepID trend (last 7d)
  const since7d = new Date(Date.now() - 7 * 86400000).toISOString();
  const { data: events } = await db
    .from('repid_score_events')
    .select('delta')
    .eq('agent_name', agentName)
    .gte('created_at', since7d);

  const weeklyDelta = (events || []).reduce((s: number, e: any) => s + (e.delta || 0), 0);

  const { data: agent } = await db
    .from('repid_agents')
    .select('current_repid, tier')
    .eq('agent_name', agentName)
    .single();

  if (agent && weeklyDelta < -(Number(agent.current_repid || 0) * 0.1)) {
    return { blocked: true, reason: 'repid_declining' };
  }

  // Check HAL vetoes (last 14d)
  const since14d = new Date(Date.now() - 14 * 86400000).toISOString();
  const { count: vetoes } = await db
    .from('hal_classifications')
    .select('*', { count: 'exact', head: true })
    .eq('hal_verdict', 'VETO')
    .gte('created_at', since14d);

  if ((vetoes || 0) > 0) {
    return { blocked: true, reason: 'recent_hal_vetoes', vetoCount: vetoes };
  }

  // Compute hold period from tier
  const holdSeconds = TIER_HOLD_PERIODS[agent?.tier || 'EARNING'] || (14 * 86400);
  const holdExpiresAt = new Date(Date.now() + holdSeconds * 1000).toISOString();

  // Lookup amount from deposit
  const { data: dep } = await db
    .from('staking_deposits')
    .select('amount_usdc')
    .eq('id', depositId)
    .single();

  const amount = dep?.amount_usdc || 0;

  const { data, error } = await db.from('staking_withdrawals').insert({
    deposit_id: depositId,
    agent_name: agentName,
    custodian_address: custodianAddress,
    amount_usdc: amount,
    hold_expires_at: holdExpiresAt,
    status: 'pending'
  }).select().single();

  if (error) throw new Error(`staking_withdrawals insert failed: ${error.message}`);
  return data;
}

// Helper for on-chain phase later
export async function getStakeForAgent(agentName: string) {
  const { data } = await db
    .from('staking_deposits')
    .select('amount_usdc, hold_until, status')
    .eq('agent_name', agentName)
    .eq('status', 'active');
  return (data || []).reduce((s: number, d: any) => s + Number(d.amount_usdc || 0), 0);
}