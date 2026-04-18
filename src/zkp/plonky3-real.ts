import { createHmac } from 'crypto';

const secret = process.env.PROOF_SECRET || 'repid-default-secret';

export function generateProofReal(agentId: string, requesterPubkey: string, tier: string, timestamp: string): string {
  return createHmac('sha256', secret)
    .update(`${agentId}:${requesterPubkey}:${tier}:${timestamp}`)
    .digest('base64');
}

export async function logProofGeneration(supabase: any, agentId: string, tier: string): Promise<void> {
  const { error } = await supabase.from('trinity_agent_logs').insert([{
    agent_name: 'repid-engine',
    action: 'zkp_proof_generated',
    message: `Proof generated for agent ${agentId} at tier ${tier}`,
    created_at: new Date().toISOString()
  }]);
  if (error) console.error('[zkp] Log error:', error);
}
