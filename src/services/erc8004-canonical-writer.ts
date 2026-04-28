import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const REPUTATION_REGISTRY = '0xB5048e3ef1DA4E04deB6f7d0423D06F63869e322';
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

// Load ABI
const abiPath = path.resolve(__dirname, '../../../hyperdag-protocol/abi/canonical/ReputationRegistry.json');
let reputationAbi: string[] = [];
try {
  reputationAbi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
} catch (e) {
  reputationAbi = [
    "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string calldata tag1, string calldata tag2, string calldata endpoint, string calldata feedbackURI, bytes32 feedbackHash) external"
  ];
}

let provider: ethers.JsonRpcProvider;
let db: any;

function getDb() {
  if (!db) {
    db = createClient(process.env.SUPABASE_URL || 'http://localhost', process.env.SUPABASE_SERVICE_KEY || 'key');
  }
  return db;
}

function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(RPC_URL);
  }
  return provider;
}

export async function writeRepIDCanonical(
  agentName: 'APM' | 'VERITAS', 
  newRepID: number
): Promise<{ tx_hash?: string; basescan_url?: string; status: string; error?: string }> {
  try {
    if (process.env.NODE_ENV === 'test') {
      return { 
        tx_hash: '0xtest', 
        basescan_url: 'https://sepolia.basescan.org/tx/0xtest', 
        status: 'skipped_in_test' 
      };
    }
    const supabase = getDb();
    // Look up canonical_agent_id
    const { data: agents, error: dbError } = await supabase
      .from('repid_agents')
      .select('canonical_agent_id')
      .eq('agent_name', agentName)
      .limit(1);

    if (dbError || !agents || agents.length === 0) {
      return { status: 'failed', error: `Agent ${agentName} not found in DB` };
    }

    const agentId = agents[0].canonical_agent_id;
    if (!agentId) {
      return { status: 'failed', error: `Agent ${agentName} has no canonical_agent_id` };
    }

    // Get private key
    const pk = agentName === 'APM' ? process.env.APM_PRIVATE_KEY : process.env.VERITAS_PRIVATE_KEY;
    if (!pk) {
      return { status: 'failed', error: `Missing private key for ${agentName}` };
    }

    const wallet = new ethers.Wallet(pk, provider);
    const contract = new ethers.Contract(REPUTATION_REGISTRY, reputationAbi, wallet);

    // Format newRepID for contract: int128 value, uint8 valueDecimals
    // Let's assume newRepID is a float like 85.5. We can multiply by 100 to get 8550 with 2 decimals.
    // Spec says: value (int128): Signed fixed-point value. valueDecimals (uint8): Decimal places
    const decimals = 2;
    const value = Math.round(newRepID * Math.pow(10, decimals));
    
    const tag1 = "RepID";
    const tag2 = "";
    const endpoint = "Trinity Demo";
    const feedbackURI = "";
    const feedbackHash = ethers.ZeroHash;

    const executeTx = async () => {
      // 30s timeout on the transaction promise
      const contractAny = contract as any;
      const txPromise = contractAny.giveFeedback(agentId, value, decimals, tag1, tag2, endpoint, feedbackURI, feedbackHash);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30000));
      const tx = await Promise.race([txPromise, timeoutPromise]) as ethers.ContractTransactionResponse;
      await tx.wait();
      return tx.hash;
    };

    let txHash: string;
    try {
      txHash = await executeTx();
    } catch (e1: any) {
      console.log(`First attempt failed: ${e1.message}. Retrying...`);
      try {
        txHash = await executeTx();
      } catch (e2: any) {
        // If it's a timeout or network error, return pending_retry
        if (e2.message.includes('Timeout') || e2.message.includes('network') || e2.code === 'NETWORK_ERROR') {
          return { status: 'pending_retry', error: e2.message };
        }
        return { status: 'failed', error: e2.message };
      }
    }

    return {
      tx_hash: txHash,
      basescan_url: `https://sepolia.basescan.org/tx/${txHash}`,
      status: 'success'
    };

  } catch (err: any) {
    return { status: 'failed', error: err.message };
  }
}
