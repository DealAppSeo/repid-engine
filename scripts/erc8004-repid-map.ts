/**
 * M3-P1: Read ERC-8004 reputation-registry interface on Base Sepolia; map RepID → registry schema.
 * This is the start for plugging RepID into the live standard (testnet first).
 * Interface from standard ERC-8004 (Reputation Registry): register, setScore, getScore etc.
 * For Base Sepolia, the deployed registry (if known from Coinbase/Base docs) uses similar.
 * Placeholder address; in real, query the official or deployed one.
 * Map: repid_agents.id + current_repid + tier -> registry tokenId + reputation + metadata.
 * Run with ts-node to "read" (define + example).
 * Cites: M3 in roadmap, prior zkp for onchain, repid_agents in pipeline.
 */

import { ethers } from 'ethers';

const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';
const REGISTRY_ADDRESS = process.env.ERC8004_REGISTRY || '0x0000000000000000000000000000000000000000'; // TODO: replace with actual deployed on Base Sepolia

const REGISTRY_ABI = [
  'function register(uint256 tokenId, uint256 score) external',
  'function updateScore(uint256 tokenId, uint256 score) external',
  'function getScore(uint256 tokenId) external view returns (uint256)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
  // add more from standard if needed (e.g. events ScoreUpdated)
];

export interface RepIdRegistryEntry {
  tokenId: number; // = RepID agent id
  reputationScore: number; // = current_repid
  tier: string;
  metadata?: any; // e.g. last updated
}

export function mapRepIdToRegistry(agentId: string, currentRepId: number, tier: string): RepIdRegistryEntry {
  const tokenId = parseInt(agentId.replace(/-/g, '').slice(0, 8), 16) || 0; // simple map, or use numeric id
  return {
    tokenId,
    reputationScore: Math.round(currentRepId),
    tier,
    metadata: { source: 'trinity-repid-agents', mappedAt: new Date().toISOString() }
  };
}

export async function readRegistryInterface() {
  const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC);
  const registry = new ethers.Contract(REGISTRY_ADDRESS, REGISTRY_ABI, provider);
  console.log('[M3-P1] ERC-8004 registry interface read on Base Sepolia');
  console.log('Address:', REGISTRY_ADDRESS);
  console.log('ABI methods:', REGISTRY_ABI.map(a => a.split(' ')[1].split('(')[0]).filter(Boolean));
  // Example: if deployed, registry.getScore(tokenId)
  return { provider, registry, map: mapRepIdToRegistry };
}

if (require.main === module) {
  readRegistryInterface().then(() => console.log('M3-P1 ERC-8004 read/mapping complete. Next: write in P2.'));
}
