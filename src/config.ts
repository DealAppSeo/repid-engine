import dotenv from 'dotenv';
dotenv.config();

export const config = {
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_SERVICE_KEY!,
  port: parseInt(process.env.PORT || '3000'),
  version: process.env.REPID_ENGINE_VERSION || '1.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  hashkeyRpc: process.env.HASHKEY_RPC_URL || 'https://rpc.hsk.xyz',
  hashkeyChainId: parseInt(process.env.HSK_CHAIN_ID || '133'),
  hashkeyContract:
    process.env.HSK_CONTRACT_ADDRESS ||
    '0xE3b55a00445dEE1e330f81d113da2E4F28131B69',
  deployerPrivateKey: process.env.DEPLOYER_PRIVATE_KEY || null,
};

if (!config.supabaseUrl || !config.supabaseKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
}
