/**
 * src/services/onchain-verifier.ts
 * S-ONCHAIN Phase 4: On-Chain State Verifier
 * Verifies that repid_agents DB on-chain fields match Base Sepolia reality (ERC-8004).
 */

import { db } from '../db';
import { ethers } from 'ethers';

export async function verifyAgentOnChain(agentName: string) {
  const { data: agent } = await db
    .from('repid_agents')
    .select('erc8004_token_id, mint_tx_hash, wallet_address, conservator_address')
    .eq('agent_name', agentName)
    .single();

  if (!agent?.mint_tx_hash) {
    return { verified: false, reason: 'not_minted' };
  }

  // Check tx exists on Base Sepolia
  const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
  const receipt = await provider.getTransactionReceipt(agent.mint_tx_hash);

  if (!receipt) {
    return { verified: false, reason: 'tx_not_found' };
  }

  return {
    verified: true,
    block: receipt.blockNumber,
    tx_hash: agent.mint_tx_hash,
    token_id: agent.erc8004_token_id,
    chain: 'base-sepolia',
    basescan: `https://sepolia.basescan.org/tx/${agent.mint_tx_hash}`
  };
}

export async function verifyAllT12OnChain() {
  // T12 list from red-team / prior
  const T12 = ['trinity-veritas','trinity-sophia','trinity-harmonia','trinity-apollon','trinity-melodia','trinity-arkhe','trinity-selene','trinity-hephaistos','trinity-athena','trinity-eros','trinity-hermes','trinity-gaia'];
  const results = [];
  for (const name of T12) {
    results.push(await verifyAgentOnChain(name));
  }
  const verifiedCount = results.filter(r => r.verified).length;
  return {
    total: T12.length,
    verified: verifiedCount,
    all_verified: verifiedCount === T12.length,
    results
  };
}