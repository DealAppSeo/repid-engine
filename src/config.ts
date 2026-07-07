import dotenv from 'dotenv';
dotenv.config();

export const config = {
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY!,
  port: parseInt(process.env.PORT || '3000'),
  version: process.env.REPID_ENGINE_VERSION || '1.0.0',
  nodeEnv: process.env.NODE_ENV || 'development',
  hashkeyRpc: process.env.HASHKEY_RPC_URL || 'https://testnet.hsk.xyz',
  hashkeyChainId: parseInt(process.env.HSK_CHAIN_ID || '133'),
  hashkeyContract:
    process.env.HSK_CONTRACT_ADDRESS ||
    '0xE3b55a00445dEE1e330f81d113da2E4F28131B69',
  deployerPrivateKey: process.env.DEPLOYER_PRIVATE_KEY || null,

  // --- Real staking (verified-deposit escrow model) -----------------------
  // Default OFF: preserves the existing simulated-accounting behavior. When
  // enabled, POST /stake/deposit requires a real Base Sepolia tx_hash that is
  // verified on-chain before a REAL (is_simulated=false) stake is recorded.
  realStakingEnabled:
    (process.env.REAL_STAKING_ENABLED || '').toLowerCase() === 'true',
  // The escrow address that must have RECEIVED the USDC deposit. FLAGGED for
  // human review (Sean's call) — assumed to be a verified-deposit EOA.
  stakeEscrowAddress: process.env.STAKE_ESCROW_ADDRESS || null,
  // Base Sepolia RPC + canonical Circle USDC token on Base Sepolia.
  baseSepoliaRpc:
    process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
  usdcTokenAddress:
    process.env.USDC_TOKEN_ADDRESS ||
    '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  // Minimum confirmations before a deposit tx is accepted.
  stakeMinConfirmations: parseInt(process.env.STAKE_MIN_CONFIRMATIONS || '1'),
};

if (!config.supabaseUrl || !config.supabaseKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY are required');
}
