import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

// ENV requirements:
// REPID_ENGINE_PUBLIC_URL - The canonical public URL for this instance (e.g. https://repid-engine-production.up.railway.app)


const REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

// Load ABI
const abiPath = path.resolve(__dirname, '../../../../hyperdag-protocol/abi/canonical/ReputationRegistry.json');
let reputationAbi: string[] = [];
try {
  reputationAbi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
} catch (e) {
  reputationAbi = [
    "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2, string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external"
  ];
}

let provider: ethers.JsonRpcProvider;

function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(RPC_URL);
  }
  return provider;
}

export async function postReputationSignal(input: {
  agentId: number;
  receiptId: string;
  receiptUri: string;
  receiptContentHash: string;
  score: number;
  scoreDecimals: number;
  tags: string[];
}): Promise<{
  txHash: string;
  blockNumber: number;
}> {
  const pk = process.env.ERC8004_OPERATOR_KEY;
  if (!pk) {
    throw new Error('Missing ERC8004_OPERATOR_KEY environment variable. SEAN DOES THIS FIRST.');
  }

  const wallet = new ethers.Wallet(pk, getProvider());
  const contract = new ethers.Contract(REPUTATION_REGISTRY, reputationAbi, wallet);

  // Format value properly
  const value = Math.round(input.score * Math.pow(10, input.scoreDecimals));
  const tag1 = input.tags && input.tags.length > 0 ? input.tags[0] : "";
  const tag2 = input.tags && input.tags.length > 1 ? input.tags[1] : "";
  
  // Endpoint links back to our receipt API
  const baseUrl = process.env.REPID_ENGINE_PUBLIC_URL || 'https://repid-engine-production.up.railway.app';
  const endpoint = `${baseUrl}/receipts/${input.receiptId}`;

  const contractAny = contract as any;
  const tx = await contractAny.giveFeedback(
    input.agentId,
    value,
    input.scoreDecimals,
    tag1,
    tag2,
    endpoint,
    input.receiptUri,
    input.receiptContentHash
  );

  const receipt = await tx.wait();

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber
  };
}
