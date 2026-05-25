export interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  rpcUrls: string[];
  contracts: {
    usdc: string;
    reputationRegistry: string;
    identityRegistry: string;
  };
  x402: {
    facilitatorUrl: string;
    networkParam: string;
  };
  caps?: {
    perContractUsdCap?: number;
    dailyVolumeUsdCap?: number;
    perAgentDailyTxCap?: number;
  };
}

export const NETWORKS: Record<string, NetworkConfig> = {
  'base-sepolia': {
    name: 'Base Sepolia',
    chainId: 84532,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
    rpcUrls: [
      process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
      process.env.BASE_SEPOLIA_RPC_URL_BACKUP_1,
      process.env.BASE_SEPOLIA_RPC_URL_BACKUP_2 || process.env.BACKUP_2,
    ].filter(Boolean) as string[],
    contracts: {
      usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
      reputationRegistry: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
      identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    },
    x402: {
      facilitatorUrl: 'https://x402.org/facilitator',
      networkParam: 'base-sepolia',
    },
  },
  'base': {
    name: 'Base Mainnet',
    chainId: 8453,
    rpcUrl: process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org',
    rpcUrls: [
      process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org',
      process.env.BASE_MAINNET_RPC_URL_BACKUP_1,
      process.env.BASE_MAINNET_RPC_URL_BACKUP_2,
    ].filter(Boolean) as string[],
    contracts: {
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      reputationRegistry: process.env.BASE_REPUTATION_REGISTRY || '', // TBD
      identityRegistry: process.env.BASE_IDENTITY_REGISTRY || '', // TBD
    },
    x402: {
      facilitatorUrl: process.env.X402_MAINNET_FACILITATOR_URL || 'https://x402.org/facilitator',
      networkParam: 'base',
    },
    caps: {
      perContractUsdCap: process.env.MAINNET_PER_CONTRACT_USD_CAP ? Number(process.env.MAINNET_PER_CONTRACT_USD_CAP) : 10,
      dailyVolumeUsdCap: process.env.MAINNET_DAILY_VOLUME_USD_CAP ? Number(process.env.MAINNET_DAILY_VOLUME_USD_CAP) : 100,
      perAgentDailyTxCap: process.env.MAINNET_PER_AGENT_DAILY_TX_CAP ? Number(process.env.MAINNET_PER_AGENT_DAILY_TX_CAP) : 50,
    },
  },
};

/**
 * Resolves and returns the configured network configuration for the active network environment.
 * The active network is specified by the NETWORK environment variable (defaults to 'base-sepolia').
 *
 * To support dynamic test configuration and runtime failover tuning, primary and backup RPC URLs,
 * as well as safety value caps, are resolved dynamically from process.env on every call.
 */
export function getActiveNetwork(): NetworkConfig {
  const networkName = process.env.NETWORK || 'base-sepolia';
  const network = NETWORKS[networkName];
  if (!network) {
    throw new Error(`Unknown network: ${networkName}. Valid: ${Object.keys(NETWORKS).join(', ')}`);
  }
  
  // Return a cloned object so we don't mutate the global config, resolving caps and RPCs dynamically
  const resolved = { ...network };
  
  if (networkName === 'base-sepolia') {
    resolved.rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
    resolved.rpcUrls = [
      resolved.rpcUrl,
      process.env.BASE_SEPOLIA_RPC_URL_BACKUP_1,
      process.env.BASE_SEPOLIA_RPC_URL_BACKUP_2 || process.env.BACKUP_2,
    ].filter(Boolean) as string[];
  } else if (networkName === 'base') {
    resolved.rpcUrl = process.env.BASE_MAINNET_RPC_URL || 'https://mainnet.base.org';
    resolved.rpcUrls = [
      resolved.rpcUrl,
      process.env.BASE_MAINNET_RPC_URL_BACKUP_1,
      process.env.BASE_MAINNET_RPC_URL_BACKUP_2,
    ].filter(Boolean) as string[];
    resolved.caps = {
      perContractUsdCap: process.env.MAINNET_PER_CONTRACT_USD_CAP ? Number(process.env.MAINNET_PER_CONTRACT_USD_CAP) : 10,
      dailyVolumeUsdCap: process.env.MAINNET_DAILY_VOLUME_USD_CAP ? Number(process.env.MAINNET_DAILY_VOLUME_USD_CAP) : 100,
      perAgentDailyTxCap: process.env.MAINNET_PER_AGENT_DAILY_TX_CAP ? Number(process.env.MAINNET_PER_AGENT_DAILY_TX_CAP) : 50,
    };
  }
  
  return resolved;
}
