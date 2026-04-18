import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { db } from '../db';
import { fireWebhook } from '../services/webhook';

export async function generateProofReal(agentId: string, requesterPubkey: string, tier: string, timestamp?: string) {
  const ts = timestamp || new Date().toISOString();
  const secretKey = new TextEncoder().encode(process.env.PROOF_SECRET || 'default_secret');
  const message = new TextEncoder().encode(`${agentId}${requesterPubkey}${tier}${ts}`);
  const proofBytes = hmac(sha256, secretKey, message);
  const proof = bytesToHex(proofBytes);

  const { error } = await db.from('trinity_agent_logs').insert({
    action: 'zkp_proof_generated',
    metadata: { agent_id: agentId, requester_pubkey: requesterPubkey, tier, timestamp: ts, proof }
  });
    if (error) console.error(error);

  fireWebhook('proof.generated', { proof, agent_id: agentId, requester_pubkey: requesterPubkey, tier, timestamp: ts });

  return { proof, timestamp: ts };
}
