import { createHash } from 'crypto';
import { db } from '../db';

export async function generateProofStub(agentId: string, requesterPubkey: string, tier: string) {
  const timestamp = new Date().toISOString();
  const dataToHash = `${agentId}${requesterPubkey}${tier}${timestamp}`;
  const proof = createHash('sha256').update(dataToHash).digest('hex');

  const { error } = await db.from('trinity_agent_logs').insert({
    action: 'zkp_proof_generated',
    metadata: {
      agent_id: agentId,
      requester_pubkey: requesterPubkey,
      tier,
      timestamp,
      proof
    }
  });
    if (error) console.error(error);

  return { proof, timestamp };
}
