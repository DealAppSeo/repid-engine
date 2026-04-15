import { ethers } from 'ethers';
import { config } from '../config';

// Minimal ABI for the HyperDAG RepID contract.
// Only the functions we need for reputation anchoring.
const REPID_ABI = [
  'function recordReputation(address agent, uint256 repId, bytes32 evidenceHash) external',
  'function getReputation(address agent) external view returns (uint256)',
  'event ReputationRecorded(address indexed agent, uint256 repId, bytes32 evidenceHash, uint256 timestamp)',
];

let provider: ethers.JsonRpcProvider | null = null;
let wallet: ethers.Wallet | null = null;
let contract: ethers.Contract | null = null;

function getContract(): ethers.Contract | null {
  if (!config.deployerPrivateKey) return null;
  if (contract) return contract;
  try {
    provider = new ethers.JsonRpcProvider(config.hashkeyRpc);
    wallet = new ethers.Wallet(config.deployerPrivateKey, provider);
    contract = new ethers.Contract(config.hashkeyContract, REPID_ABI, wallet);
    return contract;
  } catch (err) {
    console.error('[hashkey] Failed to initialize contract:', err);
    return null;
  }
}

export interface AnchorResult {
  success: boolean;
  txHash?: string;
  blockNumber?: number;
  evidenceHash: string;
  error?: string;
  stub?: boolean;
}

// Anchor a RepID event to HashKey Chain.
// Always returns a deterministic evidenceHash; tx is only submitted when
// DEPLOYER_PRIVATE_KEY is configured. Non-blocking — caller should not await
// in a path that must return fast.
export async function anchorRepIdEvent(
  agentAddress: string,
  newRepId: number,
  evidenceData: Record<string, unknown>
): Promise<AnchorResult> {
  const evidenceHash = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify(evidenceData))
  );

  const c = getContract();
  if (!c) {
    // Stub mode: no private key configured — return a deterministic "tx hash"
    // derived from the evidence hash. The challenge still completes fully.
    return {
      success: true,
      stub: true,
      evidenceHash,
      txHash: `0x${evidenceHash.slice(2, 66)}`,
      error: 'DEPLOYER_PRIVATE_KEY not configured — stub mode',
    };
  }

  try {
    console.log(`[hashkey] Anchoring RepID ${newRepId} for ${agentAddress}`);
    const tx = await (c as any).recordReputation(agentAddress, newRepId, evidenceHash);
    console.log(`[hashkey] TX submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`[hashkey] TX confirmed: block ${receipt.blockNumber}`);
    return {
      success: true,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      evidenceHash,
    };
  } catch (err: any) {
    console.error('[hashkey] Anchor failed:', err.message);
    return {
      success: false,
      stub: true,
      evidenceHash,
      error: err.message,
    };
  }
}

export async function testHashKeyConnection(): Promise<{
  connected: boolean;
  blockNumber?: number;
  chainId?: number;
  error?: string;
}> {
  try {
    const p = new ethers.JsonRpcProvider(config.hashkeyRpc);
    const [blockNumber, network] = await Promise.all([p.getBlockNumber(), p.getNetwork()]);
    return { connected: true, blockNumber, chainId: Number(network.chainId) };
  } catch (err: any) {
    return { connected: false, error: err?.message ?? 'unknown' };
  }
}
