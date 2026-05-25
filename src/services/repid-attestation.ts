import { ethers } from 'ethers';
import { db } from '../db';
import crypto from 'crypto';
import { getProvider } from '../clients/rpc-with-failover';
import { getActiveNetwork } from '../config/network';
import reputationAbiRaw from '../contracts/ReputationRegistry.abi.json';

const REPUTATION_ABI = (reputationAbiRaw as any).abi ?? (reputationAbiRaw as unknown[]);

export interface RepIdAttestation {
  version: "1";
  agent_id: string;
  agent_name: string;
  repid: number;
  tier: string;
  erc8004_chain_id: number;
  erc8004_registry: string;
  last_reputation_tx: string | null;
  issued_at: string;
  expires_at: string;
  nonce: string;
  signature: string;
}

export type ZkpRepIdAttestation = RepIdAttestation & { zkp_proof: string | null };

function getEip712Domain() {
  const net = getActiveNetwork();
  return {
    name: "HyperDAG",
    version: "1",
    chainId: net.chainId
  };
}

const TYPES = {
  RepIdAttestation: [
    { name: 'agent_id', type: 'string' },
    { name: 'repid', type: 'uint256' },
    { name: 'tier', type: 'string' },
    { name: 'issued_at', type: 'string' },
    { name: 'expires_at', type: 'string' },
    { name: 'nonce', type: 'string' }
  ]
};

export class RepIdAttestationService {
  private attestorWallet: ethers.Wallet;
  private provider: ethers.Provider;

  constructor() {
    this.provider = getProvider();

    const pk = process.env.HYPERDAG_ATTESTOR_PRIVATE_KEY;
    if (!pk) {
      console.warn('[RepIdAttestationService] HYPERDAG_ATTESTOR_PRIVATE_KEY missing. Using dev key.');
      // Hardcoded dev key for Phase 1
      const devKey = "0x53baf8310afbbcc6f496514fb4ff2d011125bb9eba6d4d2964dcd7d95251b172";
      this.attestorWallet = new ethers.Wallet(devKey, this.provider);
    } else {
      this.attestorWallet = new ethers.Wallet(pk, this.provider);
    }
    console.log(`[RepIdAttestationService] Attestor Address: ${this.attestorWallet.address}`);
  }

  async generateAttestation(agentId: string): Promise<ZkpRepIdAttestation> {
    const { data: agent, error } = await db
      .from('repid_agents')
      .select('id, agent_name, current_repid, tier, erc8004_token_id, last_reputation_tx_hash')
      .eq('id', agentId)
      .single();

    if (error || !agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const nonce = crypto.randomBytes(16).toString('hex');

    const message = {
      agent_id: agentId,
      repid: agent.current_repid,
      tier: agent.tier,
      issued_at: issuedAt,
      expires_at: expiresAt,
      nonce: nonce
    };

    const net = getActiveNetwork();
    const signature = await this.attestorWallet.signTypedData(getEip712Domain(), TYPES, message);

    const attestation: RepIdAttestation = {
      version: "1",
      agent_id: agentId,
      agent_name: agent.agent_name,
      repid: agent.current_repid,
      tier: agent.tier,
      erc8004_token_id: agent.erc8004_token_id,
      erc8004_chain_id: net.chainId,
      erc8004_registry: net.contracts.identityRegistry || '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      last_reputation_tx: agent.last_reputation_tx_hash,
      issued_at: issuedAt,
      expires_at: expiresAt,
      nonce: nonce,
      signature: signature
    };

    // Phase 1.2: ZKP wrapper
    // Try to find a recent proof. 
    // Fallback: check repid_proof_queue
    const { data: proofData } = await db
        .from('repid_proof_queue')
        .select('proof_hash')
        .eq('agent_id', agentId)
        .eq('status', 'completed')
        .order('completed_at', { ascending: false })
        .limit(1)
        .maybeSingle();

    return {
      ...attestation,
      zkp_proof: (proofData as any)?.proof_hash || null
    };
  }

  async verifyAttestation(attestation: ZkpRepIdAttestation): Promise<{ valid: boolean; reason?: string }> {
    const now = new Date();
    if (new Date(attestation.expires_at) < now) {
      return { valid: false, reason: 'Expired' };
    }

    const message = {
      agent_id: attestation.agent_id,
      repid: attestation.repid,
      tier: attestation.tier,
      issued_at: attestation.issued_at,
      expires_at: attestation.expires_at,
      nonce: attestation.nonce
    };

    try {
      const recoveredAddress = ethers.verifyTypedData(getEip712Domain(), TYPES, message, attestation.signature);
      const expectedAddress = process.env.HYPERDAG_ATTESTOR_ADDRESS || this.attestorWallet.address;

      if (recoveredAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
        return { valid: false, reason: 'Invalid signature' };
      }
    } catch (e) {
      return { valid: false, reason: 'Signature verification failed' };
    }

    // Phase 1.1: Verify on-chain RepID matches if erc8004_token_id present
    if (attestation.erc8004_token_id) {
      try {
        const net = getActiveNetwork();
        const reputationContract = net.contracts.reputationRegistry || '0x8004B663056A597Dffe9eCcC1965A193B7388713';
        const contract = new ethers.Contract(reputationContract, REPUTATION_ABI, this.provider);
        const hyperdagWallet = this.attestorWallet.address; // Assuming attestor is the one who wrote the feedback
        
        // getSummary(tokenId, clientAddresses, tag1, tag2)
        const summary = await (contract as any).getSummary?.(
          BigInt(attestation.erc8004_token_id),
          [hyperdagWallet],
          'hyperdag_repid',
          ''
        );

        if (!summary) {
          throw new Error('getSummary method not found on contract');
        }


        const onChainRepid = Number(summary[1]);
        const offChainRepid = attestation.repid;
        
        // Allow 5% drift
        const drift = Math.abs(onChainRepid - offChainRepid);
        const maxDrift = offChainRepid * 0.05;
        
        if (drift > maxDrift && onChainRepid > 0) { // If on-chain is 0, it might just not be synced yet
          return { valid: false, reason: `On-chain RepID drift too high: on-chain=${onChainRepid}, attestation=${offChainRepid}` };
        }
      } catch (e: any) {
        console.warn('[RepIdAttestationService] On-chain verification failed (skipping):', e.message);
        // Don't fail the whole thing if the RPC is flaky, but log it.
      }
    }

    return { valid: true };
  }
}

export const repIdAttestationService = new RepIdAttestationService();
