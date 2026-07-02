import { createHash } from 'crypto';
import { logAgentEvent } from '../engine/agent-log';

export async function generateProofStub(agentId: string, requesterPubkey: string, tier: string) {
  const timestamp = new Date().toISOString();
  const dataToHash = `${agentId}${requesterPubkey}${tier}${timestamp}`;
  const proof = createHash('sha256').update(dataToHash).digest('hex');

  // Routine proof-generation log — gated by AGENT_LOG_SAMPLE / AGENT_LOG_MIN_LEVEL to curb noise
  // in the write-only trinity_agent_logs table. (Stub behavior — Sprint 3 contract surface — is
  // unchanged; only the monitoring insert is now sampleable.)
  await logAgentEvent(
    {
      action: 'zkp_proof_generated',
      metadata: {
        agent_id: agentId,
        requester_pubkey: requesterPubkey,
        tier,
        timestamp,
        proof
      }
    },
    'info'
  );

  return { proof, timestamp };
}
