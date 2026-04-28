import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const VALIDATION_REGISTRY = process.env.VALIDATION_REGISTRY_ADDRESS || '0x0000000000000000000000000000000000000000';
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

// Load ABI
const abiPath = path.resolve(__dirname, '../../../hyperdag-protocol/abi/canonical/ValidationRegistry.json');
let validationAbi: string[] = [];
try {
  validationAbi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
} catch (e) {
  validationAbi = [
    "function submitValidationTask(uint256 agentId, bytes32 taskHash, uint256 timeout, bytes calldata taskData) external returns (uint256 taskId)",
    "function resolveTask(uint256 taskId, bool success, bytes calldata resolutionData) external"
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

export async function submitValidation(
  validatorAgentName: string,
  requesterAgentId: string,
  responseHash: string,
  dataURI: string
): Promise<{ tx_hash?: string; basescan_url?: string; status: string; error?: string }> {
  try {
    const supabase = getDb();
    
    // Look up validator's private key based on name
    const pkVarName = `${validatorAgentName.toUpperCase()}_PRIVATE_KEY`;
    const pk = process.env[pkVarName];
    if (!pk) {
      return { status: 'failed', error: `Missing private key for validator ${validatorAgentName}` };
    }

    // Get canonical_agent_id for validator (optional for the smart contract, but good for logs)
    const { data: agents, error: dbError } = await supabase
      .from('repid_agents')
      .select('canonical_agent_id')
      .eq('agent_name', validatorAgentName)
      .limit(1);

    const validatorAgentId = (agents && agents.length > 0) ? agents[0].canonical_agent_id : null;

    const wallet = new ethers.Wallet(pk, getProvider());
    const contract = new ethers.Contract(VALIDATION_REGISTRY, validationAbi, wallet);

    const agentId = BigInt(requesterAgentId);
    // Ensure responseHash is 32 bytes (66 chars including 0x)
    const taskHash = ethers.isHexString(responseHash, 32) ? responseHash : ethers.id(responseHash);
    const timeout = 3600; // 1 hour timeout
    const taskData = ethers.toUtf8Bytes(dataURI);

    const executeTx = async () => {
      const contractAny = contract as any;
      const txPromise = contractAny.submitValidationTask(agentId, taskHash, timeout, taskData);
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
        if (e2.message.includes('Timeout') || e2.message.includes('network') || e2.code === 'NETWORK_ERROR') {
          return { status: 'pending_retry', error: e2.message };
        }
        return { status: 'failed', error: e2.message };
      }
    }

    // Persist to validation_log
    const { error: insertError } = await supabase.from('validation_log').insert({
      validator_agent_id: validatorAgentId || validatorAgentName,
      target_agent_id: requesterAgentId,
      request_hash: taskHash,
      response_hash: taskHash,
      tx_hash: txHash,
      basescan_url: `https://sepolia.basescan.org/tx/${txHash}`
    });

    if (insertError) {
      console.error('Failed to log validation:', insertError);
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
