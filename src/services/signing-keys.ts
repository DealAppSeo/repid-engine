import { ethers } from 'ethers';

interface SpokespersonKey {
  agentName: string;
  expectedAddress: string;
  wallet: ethers.Wallet | null;
  status: 'loaded' | 'missing' | 'mismatch';
  message?: string;
}

const EXPECTED_ADDRESSES: Record<string, string> = {
  'trinity-shofet': '0x15eB9A7427f1B54486926465d5895cD51eB8b052',
  'trinity-veritas': '0x2832eB385cbe9e71aCf2351489eb62F970EDe9b9',
  'trinity-apm': '0xceD17F65E03e7b3a77D5321A2d3715840317199C',
  'trinity-sophia': '0x7b84CCE5502d393DAa6533285eF3e2f8D3A13261'
};

const ENV_VAR_MAP: Record<string, string> = {
  'trinity-shofet': 'SHOFET_SIGNING_KEY',
  'trinity-veritas': 'VERITAS_SIGNING_KEY',
  'trinity-apm': 'APM_SIGNING_KEY',
  'trinity-sophia': 'SOPHIA_SIGNING_KEY'
};

export function loadSpokespersonKeys(): Record<string, SpokespersonKey> {
  const result: Record<string, SpokespersonKey> = {};
  
  for (const [agentName, expectedAddress] of Object.entries(EXPECTED_ADDRESSES)) {
    const envVar = ENV_VAR_MAP[agentName];
    const key = process.env[envVar];
    
    if (!key) {
      result[agentName] = {
        agentName,
        expectedAddress,
        wallet: null,
        status: 'missing',
        message: `Env var ${envVar} not set`
      };
      continue;
    }
    
    try {
      const wallet = new ethers.Wallet(key);
      if (wallet.address.toLowerCase() !== expectedAddress.toLowerCase()) {
        result[agentName] = {
          agentName,
          expectedAddress,
          wallet: null,
          status: 'mismatch',
          message: `Key resolves to ${wallet.address}, expected ${expectedAddress}`
        };
      } else {
        result[agentName] = {
          agentName,
          expectedAddress,
          wallet,
          status: 'loaded'
        };
      }
    } catch (e: any) {
      result[agentName] = {
        agentName,
        expectedAddress,
        wallet: null,
        status: 'missing',
        message: `Invalid key format: ${e.message}`
      };
    }
  }
  
  return result;
}

export function getSpokespersonWallet(agentName: string): ethers.Wallet | null {
  const keys = loadSpokespersonKeys();
  return keys[agentName]?.wallet || null;
}
