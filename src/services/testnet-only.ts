/**
 * Base Sepolia record. Chain 84532 only.
 * This module does not build a transaction and does not send ETH.
 */

export const BASE_SEPOLIA_CHAIN_ID = 84532;

export interface TestnetOnly {
  chain_id: number;
  network: 'base-sepolia' | 'refused';
  sends_eth: false;
  applied: false;
  persisted: false;
  reason: 'testnet_record_only' | 'refused_not_base_sepolia';
}

export function testnetOnly(chainId: number = BASE_SEPOLIA_CHAIN_ID): TestnetOnly {
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    return {
      chain_id: chainId,
      network: 'refused',
      sends_eth: false,
      applied: false,
      persisted: false,
      reason: 'refused_not_base_sepolia',
    };
  }
  return {
    chain_id: BASE_SEPOLIA_CHAIN_ID,
    network: 'base-sepolia',
    sends_eth: false,
    applied: false,
    persisted: false,
    reason: 'testnet_record_only',
  };
}
