import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fractionForRepID } from './repid-fraction';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

export async function decideTrade(input: { agentId: string, tradeSizeUSD: number, userAddress?: string }): Promise<{
  decision: 'approved' | 'rejected_size' | 'rejected_no_stake' | 'rejected_repid_too_low';
  max_allowed_usd: number;
  fraction_used: number;
  repid_at_decision: number;
  total_stake_backing_usd: number;
  reason: string | null;
  attempt_id: string;
}> {
  const { agentId, tradeSizeUSD, userAddress } = input;

  // 1. Get agent
  const { data: agent, error: agentErr } = await supabase
    .from('repid_mvp_agents')
    .select('*')
    .eq('agent_id', agentId)
    .single();

  if (agentErr || !agent) throw new Error(`Agent not found: ${agentId}`);

  let repid_score = agent.repid_score;
  let fraction = 0;
  let max_allowed_usd = 0;
  let total_stake_backing_usd = 0;
  let decision: 'approved' | 'rejected_size' | 'rejected_no_stake' | 'rejected_repid_too_low' = 'approved';
  let reason: string | null = null;
  let usedUserId: string | null = null;

  // Look up user if specified
  if (userAddress) {
    const { data: user, error: userErr } = await supabase
      .from('repid_mvp_users')
      .select('id')
      .eq('user_address', userAddress)
      .single();
    if (userErr || !user) throw new Error(`User not found: ${userAddress}`);
    usedUserId = user.id;
  }

  // Check repid
  if (repid_score <= 0) {
    decision = 'rejected_repid_too_low';
    reason = 'Agent RepID is 0 or negative.';
  } else {
    fraction = fractionForRepID(repid_score);

    // Sum active stakes for agent
    let query = supabase
      .from('repid_mvp_stakes')
      .select('stake_amount_usd, user_id')
      .eq('agent_id', agent.id)
      .eq('status', 'active');

    if (usedUserId) {
      query = query.eq('user_id', usedUserId);
    }

    const { data: stakes, error: stakesErr } = await query;
    if (stakesErr) throw new Error(`Failed to fetch stakes: ${stakesErr.message}`);

    total_stake_backing_usd = stakes.reduce((sum: number, s: any) => sum + Number(s.stake_amount_usd), 0);

    if (total_stake_backing_usd <= 0) {
      decision = 'rejected_no_stake';
      reason = 'No active stakes backing this agent.';
    } else {
      max_allowed_usd = total_stake_backing_usd * fraction;
      if (tradeSizeUSD > max_allowed_usd) {
        decision = 'rejected_size';
        reason = `Trade size $${tradeSizeUSD} exceeds maximum allowed $${max_allowed_usd}`;
      }
    }
  }

  // Get a user_id to write to repid_mvp_trade_attempts
  // If userAddress wasn't passed, we need some user_id associated with the stake, or null?
  // Table schema requires user_id. We'll grab the first active staker if not specified.
  if (!usedUserId && decision !== 'rejected_no_stake') {
    const { data: stakes } = await supabase
      .from('repid_mvp_stakes')
      .select('user_id')
      .eq('agent_id', agent.id)
      .eq('status', 'active')
      .limit(1);
    if (stakes && stakes.length > 0) {
      usedUserId = (stakes[0] as any).user_id;
    }
  }

  // If we still don't have a user, fetch a default one or throw
  if (!usedUserId) {
    // Just find any user to fulfill the constraint, or it'll fail the foreign key.
    // In a real system, trade attempts are initiated by SOME user or agent on behalf of someone.
    const { data: anyUser } = await supabase.from('repid_mvp_users').select('id').limit(1).single();
    if (anyUser) usedUserId = anyUser.id;
  }

  // Write attempt
  const { data: attempt, error: attemptErr } = await supabase
    .from('repid_mvp_trade_attempts')
    .insert({
      agent_id: agent.id,
      user_id: usedUserId, // Best effort
      trade_size_usd: tradeSizeUSD,
      repid_at_decision: repid_score,
      max_allowed_usd: max_allowed_usd,
      fraction_used: fraction,
      decision: decision,
      reason: reason,
      executed: decision === 'approved',
      executed_at: decision === 'approved' ? new Date().toISOString() : null
    })
    .select('id')
    .single();

  if (attemptErr) {
    console.error(`[TradeDecisionEngine] Failed to write attempt: ${attemptErr.message}`);
  }

  return {
    decision,
    max_allowed_usd,
    fraction_used: fraction,
    repid_at_decision: repid_score,
    total_stake_backing_usd,
    reason,
    attempt_id: attempt ? attempt.id : 'unknown'
  };
}
