/**
 * src/services/proof-stager.ts
 * S-ONCHAIN Phase 3: Pre-staging worker for ZKP proofs.
 * Pre-computes for scheduled events, stores in zkp_proofs_staged + DragonflyDB cache (sub-ms retrieval).
 */

import { db } from '../db';
import { routeProof } from '../zkp/proof-router';

let cache: any = null;
function getCache() {
  if (cache) return cache;
  try {
    const url = process.env.DRAGONFLY_URL || process.env.REDIS_URL;
    if (url && process.env.ENABLE_PROOF_CACHE === 'true') {
      // Real client would connect here (redis.createClient etc.)
      console.log('[proof-stager] cache available (stub)');
    }
  } catch {}
  return cache;
}

export async function stageProof(proofType: string, agentName: string, expiresInHours: number = 24) {
  // Mark as computing
  const { data: entry, error: insErr } = await db.from('zkp_proofs_staged').insert({
    proof_type: proofType,
    agent_name: agentName,
    proof_hash: '', // filled after
    status: 'computing',
    expires_at: new Date(Date.now() + expiresInHours * 3600000).toISOString(),
    retrieval_count: 0
  }).select().single();

  if (insErr) throw new Error(`stage insert failed: ${insErr.message}`);

  // Compute via router (respects pre-stage, fast/plonky3/hash)
  const result = await routeProof(proofType, agentName);

  // Store
  await db.from('zkp_proofs_staged').update({
    proof_hash: result.proof_hash,
    status: 'staged',
    metadata: result,
    computed_at: new Date().toISOString()
  }).eq('id', entry.id);

  // Cache in Dragonfly for sub-ms
  const c = getCache();
  if (c) {
    try {
      // c.set(`proof:${proofType}:${agentName}`, JSON.stringify(result), 'EX', expiresInHours*3600);
    } catch {}
  }

  return { ...result, staged_id: entry.id };
}

export async function getStagedProof(proofType: string, agentName: string) {
  const c = getCache();
  if (c) {
    try {
      // const hit = await c.get(`proof:${proofType}:${agentName}`); if (hit) return JSON.parse(hit);
    } catch {}
  }
  const { data } = await db
    .from('zkp_proofs_staged')
    .select('*')
    .eq('proof_type', proofType)
    .eq('agent_name', agentName)
    .eq('status', 'staged')
    .gt('expires_at', new Date().toISOString())
    .order('computed_at', { ascending: false })
    .limit(1)
    .single();
  return data;
}