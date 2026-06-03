/**
 * src/services/proof-stager.ts
 * S-ONCHAIN Phase 3.2: Pre-staging worker
 * Pre-computes proofs for scheduled events.
 * Stores in zkp_proofs_staged + DragonflyDB cache (sub-ms retrieval).
 */

import { db } from '../db';
import { routeProof } from '../zkp/proof-router';

let cache: any = null;
function getCache(): any {
  if (cache) return cache;
  // TODO: real Dragonfly/Redis client (e.g. from 'redis' or project cache)
  const url = process.env.DRAGONFLY_URL || process.env.REDIS_URL;
  if (url) {
    console.log('[proof-stager] Dragonfly cache available (stub - implement client)');
  }
  return cache;
}

export async function stageProof(proofType: string, agentName: string, expiresInHours: number = 24) {
  // Mark as computing
  const { data: entry } = await db.from('zkp_proofs_staged').insert({
    proof_type: proofType,
    agent_name: agentName,
    proof_hash: '', // filled after computation
    status: 'computing',
    expires_at: new Date(Date.now() + expiresInHours * 3600000).toISOString()
  }).select().single();

  // Compute proof
  const result = await routeProof(proofType, agentName);

  // Store proof
  await db.from('zkp_proofs_staged').update({
    proof_hash: result.proof_hash,
    status: 'staged',
    metadata: result
  }).eq('id', entry.id);

  // Cache in DragonflyDB for sub-ms retrieval
  const c = getCache();
  if (c) {
    // await c.set(`proof:${proofType}:${agentName}`, JSON.stringify(result), 'EX', expiresInHours * 3600);
  }

  return result;
}