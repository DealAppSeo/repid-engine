/**
 * src/services/onchain-verifier.ts
 * S-ONCHAIN Phase 4: On-Chain State Verifier
 * Verifies repid_agents DB state matches Base Sepolia on-chain (ERC-8004 mints).
 * Uses public RPC + tx receipt.
 */

import { db } from '../db';
import { ethers } from 'ethers';

const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';
const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';

export async function verifyAgentOnChain(agentName: string) {
  const { data: agent } = await db
    .from('repid_agents')
    .select('erc8004_token_id, mint_tx_hash, wallet_address, conservator_address, mint_block_number')
    .eq('agent_name', agentName)
    .single();

  if (!agent?.mint_tx_hash) {
    return { verified: false, reason: 'not_minted', agent: agentName };
  }

  try {
    const provider = new ethers.JsonRpcProvider(BASE_SEPOLIA_RPC);
    const receipt = await provider.getTransactionReceipt(agent.mint_tx_hash);

    if (!receipt) {
      return { verified: false, reason: 'tx_not_found', tx: agent.mint_tx_hash };
    }

    if (receipt.status !== 1) {
      return { verified: false, reason: 'tx_failed', tx: agent.mint_tx_hash };
    }

    return {
      verified: true,
      agent: agentName,
      block: receipt.blockNumber,
      tx_hash: agent.mint_tx_hash,
      token_id: agent.erc8004_token_id,
      chain: 'base-sepolia',
      basescan: `https://sepolia.basescan.org/tx/${agent.mint_tx_hash}`,
      contract: REGISTRY,
      owner: receipt.from // the minter/deployer at time of tx
    };
  } catch (e: any) {
    return { verified: false, reason: 'rpc_error', message: e.message };
  }
}

export async function verifyAllT12OnChain() {
  const T12 = [
    'trinity-veritas','trinity-sophia','trinity-harmonia','trinity-apollon',
    'trinity-melodia','trinity-arkhe','trinity-selene','trinity-hephaistos',
    'trinity-athena','trinity-eros','trinity-hermes','trinity-gaia'
  ];
  const results = await Promise.all(T12.map(name => verifyAgentOnChain(name)));
  const verifiedCount = results.filter(r => r.verified).length;
  return {
    total: T12.length,
    verified: verifiedCount,
    all_verified: verifiedCount === T12.length,
    results
  };
}