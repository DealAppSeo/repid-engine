import { db } from '../db';
import { cacheGet, cacheSet } from './dragonfly';

export interface StagedProof {
  proof_type: string;
  agent_name: string;
  proof_data: string; // Hex string
  proof_hash: string;
  merkle_root: string;
  anchor_tx_hash: string;
  status: string;
  metadata?: any;
}

export async function getCachedStagedProof(proofHash: string): Promise<StagedProof | null> {
  const key = `proof:${proofHash}`;
  const cached = await cacheGet(key);
  if (cached) {
    try {
      return JSON.parse(cached) as StagedProof;
    } catch { /* ignore */ }
  }

  // Fallback to Supabase zkp_proofs_staged table
  const { data } = await db
    .from('zkp_proofs_staged')
    .select('*')
    .eq('proof_hash', proofHash)
    .eq('status', 'valid')
    .maybeSingle();

  if (data) {
    const proof: StagedProof = {
      proof_type: data.proof_type ?? '',
      agent_name: data.agent_name ?? '',
      proof_data: data.proof_data ? Buffer.from(data.proof_data).toString('hex') : '',
      proof_hash: data.proof_hash ?? '',
      merkle_root: data.merkle_root || '',
      anchor_tx_hash: data.anchor_tx_hash || '',
      status: data.status ?? 'valid',
      metadata: data.metadata,
    };
    // Save to Dragonfly with 2 hours TTL
    await cacheSet(key, JSON.stringify(proof), 7200);
    return proof;
  }
  return null;
}

export async function cacheStagedProof(proof: StagedProof): Promise<void> {
  const key = `proof:${proof.proof_hash}`;
  await cacheSet(key, JSON.stringify(proof), 7200);

  // Write through to Supabase zkp_proofs_staged
  await db.from('zkp_proofs_staged').insert({
    proof_type: proof.proof_type,
    agent_name: proof.agent_name,
    proof_data: Buffer.from(proof.proof_data, 'hex'),
    proof_hash: proof.proof_hash,
    merkle_root: proof.merkle_root,
    anchor_tx_hash: proof.anchor_tx_hash,
    status: proof.status || 'valid',
    metadata: proof.metadata || {},
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7200 * 1000).toISOString()
  });
}
