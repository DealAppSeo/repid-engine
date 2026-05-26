import { generateProofReal, ProofSource } from '../zkp/plonky3-real';

export interface ProofGenerationRequest {
  agent_id: string;
  requester_pubkey: string;
  requested_tier: string;
  timestamp: string;
}

export interface ProofGenerationResult {
  proof: string;
  proof_source: ProofSource;
  proofFormat: string;
  proofVersion: string;
}

/**
 * TypeScript wrapper for ZK proof generation.
 * Currently interfaces with the Plonky3 prover bridge client.
 * Sets up the API interface for the V2 Rust/Plonky3 integration.
 */
export async function generateProof(req: ProofGenerationRequest): Promise<ProofGenerationResult> {
  const result = await generateProofReal(
    req.agent_id,
    req.requester_pubkey,
    req.requested_tier,
    req.timestamp
  );

  return {
    proof: result.proof,
    proof_source: result.proof_source,
    proofFormat: result.proof_source === 'plonky3_real' ? 'plonky3-real-v1' : 'plonky3-babybear-stub-v1',
    proofVersion: '1.0',
  };
}
