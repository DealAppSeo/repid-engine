/**
 * src/services/staking-vault.ts
 * S-ONCHAIN Phase 2: Staking Vault Interface
 * Phase 1 (MVP): writes to Supabase staking_deposits / staking_withdrawals tables
 * Phase 2 (future): calls StakingVault.sol on Base Sepolia
 *
 * Security (Phase 6): All financial writes must have input validation, Dragonfly rate limiting,
 * auth (custodian signature or API key), and hash-chain entry (see S-AUD1).
 */

import { db } from '../db';

// Exact TIER_HOLD_PERIODS from spec (seconds)
const TIER_HOLD_PERIODS = {
  PROBATIONARY: null, // can't stake
  EARNING: 14 * 86400, // 14 days in seconds
  ESTABLISHED: 10 * 86400,
  AUTONOMOUS: 7 * 86400,
  VETERAN: 3 * 86400,
};

export async function recordDeposit(
  agentName: string, custodianAddress: string,
  amountUsdc: number, txHash?: string
) {
  // Validate agent exists
  const { data: agent } = await db
    .from('repid_agents')
    .select('tier')
    .eq('agent_name', agentName)
    .single();

  if (!agent) throw new Error('Agent not found');
  if (agent.tier === 'PROBATIONARY') throw new Error('PROBATIONARY agents cannot stake');

  const holdSeconds = TIER_HOLD_PERIODS[agent.tier as keyof typeof TIER_HOLD_PERIODS];
  const holdUntil = holdSeconds 
    ? new Date(Date.now() + holdSeconds * 1000).toISOString()
    : null;

  return db.from('staking_deposits').insert({
    agent_name: agentName,
    custodian_address: custodianAddress,
    amount_usdc: amountUsdc,
    tx_hash: txHash,
    hold_until: holdUntil,
    status: 'active'
  }).select().single();
}

export async function requestWithdrawal(
  depositId: string, agentName: string, custodianAddress: string
) {
  // Check for open disputes
  const { count: disputes } = await db
    .from('dispute_claims')
    .select('*', { count: 'exact', head: true })
    .eq('defendant_agent', agentName)
    .in('status', ['filed', 'reviewing']);

  if ((disputes || 0) > 0) {
    return { blocked: true, reason: 'open_dispute', disputeCount: disputes || 0 };
  }

  // Check RepID trend
  const { data: events } = await db
    .from('repid_score_events')
    .select('delta')
    .eq('agent_name', agentName)
    .gte('created_at', new Date(Date.now() - 7*86400000).toISOString());

  const weeklyDelta = events?.reduce((s, e) => s + (e.delta || 0), 0) || 0;
  const { data: agent } = await db
    .from('repid_agents')
    .select('current_repid, tier')
    .eq('agent_name', agentName)
    .single();

  if (agent && weeklyDelta < -(agent.current_repid * 0.1)) {
    return { blocked: true, reason: 'repid_declining' };
  }

  // Check HAL vetoes
  const { count: vetoes } = await db
    .from('hal_classifications')
    .select('*', { count: 'exact', head: true })
    .eq('hal_verdict', 'VETO')
    .gte('created_at', new Date(Date.now() - 14*86400000).toISOString());

  if ((vetoes || 0) > 0) {
    return { blocked: true, reason: 'recent_hal_vetoes', vetoCount: vetoes || 0 };
  }

  // Compute hold period
  const holdSeconds = TIER_HOLD_PERIODS[(agent?.tier || 'EARNING') as keyof typeof TIER_HOLD_PERIODS];
  const holdExpiresAt = new Date(Date.now() + (holdSeconds || 14*86400)*1000).toISOString();

  return db.from('staking_withdrawals').insert({
    deposit_id: depositId,
    agent_name: agentName,
    custodian_address: custodianAddress,
    amount_usdc: 0, // filled from deposit lookup
    hold_expires_at: holdExpiresAt,
    status: 'pending'
  }).select().single();
}