import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fractionForRepID } from './repid-fraction';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

export interface RepIDUser {
  id: string;
  user_address: string;
  display_name: string | null;
  created_at: string;
}

export interface RepIDStake {
  id: string;
  user_id: string;
  agent_id: string;
  stake_amount_usd: number;
  status: string;
  created_at: string;
  withdrawn_at: string | null;
}

export async function createUser(address: string, displayName?: string): Promise<RepIDUser> {
  if (!address) throw new Error('user_address is required');
  
  const { data, error } = await supabase
    .from('repid_mvp_users')
    .insert({ user_address: address, display_name: displayName })
    .select('*')
    .single();

  if (error) {
    throw new Error(`Failed to create user: ${error.message}`);
  }
  
  console.log(`[StakingService] Created user ${address}`);
  return data;
}

export async function stakeAndBind(userAddress: string, agentId: string, amountUSD: number): Promise<RepIDStake> {
  if (amountUSD <= 0) throw new Error('stake_amount_usd must be > 0');

  // Find user ID
  const { data: user, error: userErr } = await supabase
    .from('repid_mvp_users')
    .select('id')
    .eq('user_address', userAddress)
    .single();
    
  if (userErr || !user) throw new Error(`User not found: ${userAddress}`);

  // Find agent ID by natural key
  const { data: agent, error: agentErr } = await supabase
    .from('repid_mvp_agents')
    .select('id')
    .eq('agent_id', agentId)
    .single();
    
  if (agentErr || !agent) throw new Error(`Agent not found: ${agentId} - ${agentErr?.message || 'No agent'}`);

  // Create stake
  const { data: stake, error: stakeErr } = await supabase
    .from('repid_mvp_stakes')
    .insert({
      user_id: user.id,
      agent_id: agent.id,
      stake_amount_usd: amountUSD,
      status: 'active'
    })
    .select('*')
    .single();

  if (stakeErr) throw new Error(`Failed to create stake: ${stakeErr.message}`);

  console.log(`[StakingService] User ${userAddress} staked $${amountUSD} to agent ${agentId}`);
  return stake;
}

export async function withdrawStake(stakeId: string): Promise<void> {
  const { error } = await supabase
    .from('repid_mvp_stakes')
    .update({ 
      status: 'withdrawn',
      withdrawn_at: new Date().toISOString()
    })
    .eq('id', stakeId)
    .eq('status', 'active');
    
  if (error) throw new Error(`Failed to withdraw stake: ${error.message}`);
  
  console.log(`[StakingService] Withdrew stake ${stakeId}`);
}

export async function getUserPosition(userAddress: string): Promise<any> {
  const { data: user, error: userErr } = await supabase
    .from('repid_mvp_users')
    .select('*')
    .eq('user_address', userAddress)
    .single();
    
  if (userErr || !user) throw new Error(`User not found: ${userAddress}`);

  const { data: stakes, error: stakesErr } = await supabase
    .from('repid_mvp_stakes')
    .select(`
      *,
      agent:repid_mvp_agents(*)
    `)
    .eq('user_id', user.id)
    .eq('status', 'active');

  if (stakesErr) throw new Error(`Failed to get stakes: ${stakesErr.message}`);

  const activeStakes = stakes.map((s: any) => {
    const fraction = fractionForRepID(s.agent.repid_score);
    return {
      stake: s,
      agent: s.agent,
      current_fraction: fraction,
      max_allowed_trade_usd: s.stake_amount_usd * fraction
    };
  });

  return {
    user,
    stakes: activeStakes
  };
}
