/**
 * src/zkp/proof-router.ts
 * S-ONCHAIN owned: ZKP proof routing for V1.4.
 * Routes based on zkp_routing_config (sensitivity, frequency, regulatory_tag) to fast (Groth16+Poseidon2) or heavy (Plonky3 STARK).
 * Logs decision per proof for audit.
 * Used by proof-drain and mvp-api.
 */

import { db } from '../db';

export interface RouteDecision {
  proof_type: string;
  route_to: 'fast_groth16' | 'plonky3_stark' | 'hash';
  tier: 1 | 2 | 3; // 1=hash/keccak/Merkle low, 2=fast_groth standard, 3=plonky vault (prove w/o reveal)
  sensitivity?: number;
  regulatory_tag?: string;
  pre_stageable?: boolean;
  reason: string;
}

export async function routeProofRequest(proofType: string, context?: { agentRepId?: number; sensitivityHint?: number }): Promise<RouteDecision> {
  const { data: cfg } = await db
    .from('zkp_routing_config')
    .select('*')
    .eq('proof_type', proofType)
    .eq('active', true)
    .maybeSingle();

  if (!cfg) {
    return { proof_type: proofType, route_to: 'fast_groth16', tier: 2, reason: 'no config, default fast' };
  }

  let route_to: 'fast_groth16' | 'plonky3_stark' | 'hash' = cfg.zkp_system || 'fast_groth16';
  let tier: 1 | 2 | 3 = 2;
  let reason = 'config zkp_system';

  // Classify per design (sensitivity + freq + tag) + explicit 3-tier per BUILD sprint B0/B4
  // tier1: hash/keccak/Merkle-DAG (low sens, postcard-like)
  // tier2: fast_groth16+Poseidon (standard envelope)
  // tier3: plonky3_stark vault (sensitive, prove-without-reveal, recursive agg)
  const sens = cfg.sensitivity || 0.5;
  if (sens > 0.85 || (cfg.regulatory_tag && cfg.frequency === 'high')) {
    route_to = 'plonky3_stark';
    tier = 3;
    reason = `vault tier3 high sens ${sens} or reg+high ${cfg.regulatory_tag}`;
  } else if (sens > 0.7 || cfg.regulatory_tag || cfg.frequency === 'high') {
    route_to = 'plonky3_stark';
    tier = 3;
    reason = `high sens ${sens} or reg ${cfg.regulatory_tag} or freq ${cfg.frequency}`;
  } else if (sens < 0.3) {
    route_to = 'fast_groth16';
    tier = 2;
    reason = `low sens ${sens}`;
  } else {
    tier = 2;
  }

  // Log decision (per proof request)
  console.log(`[ZKP Router] ${proofType} -> ${route_to} (${reason}) pre_stage=${cfg.pre_stageable}`);

  return {
    proof_type: proofType,
    route_to,
    tier,
    sensitivity: sens,
    regulatory_tag: cfg.regulatory_tag,
    pre_stageable: cfg.pre_stageable,
    reason
  };
}

export default { routeProofRequest };