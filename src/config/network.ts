export interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  contracts: {
    usdc: string;
    reputationRegistry: string;
    identityRegistry: string;
  };
  x402: {
    facilitatorUrl: string;
    networkParam: string;
  };
}

export const NETWORKS: Record<string, NetworkConfig> = {
  'base-sepolia': {
    name: 'Base Sepolia',
    chainId: 84532,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
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
    contracts: {
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      reputationRegistry: process.env.BASE_REPUTATION_REGISTRY || '', // TBD
      identityRegistry: process.env.BASE_IDENTITY_REGISTRY || '', // TBD
    },
    x402: {
      facilitatorUrl: process.env.X402_MAINNET_FACILITATOR_URL || 'https://x402.org/facilitator',
      networkParam: 'base',
    },
  },
};

export function getActiveNetwork(): NetworkConfig {
  const networkName = process.env.NETWORK || 'base-sepolia';
  const network = NETWORKS[networkName];
  if (!network) {
    throw new Error(`Unknown network: ${networkName}. Valid: ${Object.keys(NETWORKS).join(', ')}`);
  }
  return network;
}
