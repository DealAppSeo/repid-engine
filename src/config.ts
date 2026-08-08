import dotenv from 'dotenv';
dotenv.config();

// --- SELF-HOST / DATA-LOCAL boundary flags -------------------------------
// LOCAL_MODE lets the engine BOOT without a hosted Supabase (the throw below
// otherwise kills a fresh clone that has no SUPABASE_URL). It is default-OFF:
// when unset the hosted contract is byte-for-byte unchanged — the same throw
// fires on a missing URL/key. When 'true', a missing SUPABASE_URL/key is
// backfilled with a loopback default so the core service can come up against a
// local store instead of aborting at import time. This is the ONLY behavior
// LOCAL_MODE changes in this file. See src/selfhost.ts + SELFHOST.md.
export const LOCAL_MODE =
  (process.env.LOCAL_MODE || '').toLowerCase() === 'true';

// ONLY_ATTESTATIONS_LEAVE is the data-locality egress boundary flag. When set,
// the egress guard (src/selfhost/egress-guard.ts) refuses to send prompt or
// response TEXT to a non-loopback host — proofs / EAS anchors / chain writes
// are still allowed to leave. Default-OFF and non-load-bearing here; it is read
// by the guard, not by this module. Surfaced on config for one import point.
export const ONLY_ATTESTATIONS_LEAVE =
  (process.env.ONLY_ATTESTATIONS_LEAVE || '').toLowerCase() === 'true';

// OpenAI-compatible base-URL override for the HAL quorum. When set, the core
// openai-compat providers target THIS base instead of api.groq.com / api.*,
// so the quorum can point at a local Ollama (http://localhost:11434/v1) or
// vLLM. Default-empty → provider endpoints are unchanged. Consumed by
// src/hal/cross-llm-client.ts. A trailing '/chat/completions' is appended if
// the value looks like a base ('/v1' or bare host) rather than a full path.
export const LOCAL_LLM_BASE_URL =
  process.env.LOCAL_LLM_BASE_URL || process.env.OPENAI_BASE_URL || '';

// Loopback defaults used ONLY in LOCAL_MODE when the real values are absent.
const LOCAL_SUPABASE_URL_DEFAULT = 'http://127.0.0.1:54321';
const LOCAL_SUPABASE_KEY_DEFAULT = 'local-mode-no-hosted-key';

export const config = {
  supabaseUrl:
    process.env.SUPABASE_URL ||
    (LOCAL_MODE ? LOCAL_SUPABASE_URL_DEFAULT : (undefined as unknown as string)),
  // Canonical DB secret = SUPABASE_SECRET_KEY (Supabase's new-format `sb_secret_…`
  // key). The legacy JWT names (SUPABASE_SERVICE_ROLE_KEY, SUPABASE_SERVICE_KEY,
  // SUPABASE_KEY) remain as transition fallbacks — set/rotate SUPABASE_SECRET_KEY
  // in Railway and the legacy ones can be deleted. New name is tried FIRST so a
  // rotation is a single env add; behavior is unchanged until it is set.
  supabaseKey:
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    process.env.SUPABASE_KEY ||
    (LOCAL_MODE ? LOCAL_SUPABASE_KEY_DEFAULT : (undefined as unknown as string)),
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
  // Hosted contract preserved: with LOCAL_MODE off this throws exactly as before.
  throw new Error(
    'SUPABASE_URL and SUPABASE_SECRET_KEY (or a legacy SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY fallback) are required',
  );
}

if (LOCAL_MODE) {
  // NO SILENT DEGRADATION: announce the data-local boundary loudly at boot so an
  // operator never mistakes a local process for a hosted one.
  const usingLocalDb = config.supabaseUrl === LOCAL_SUPABASE_URL_DEFAULT;
  // eslint-disable-next-line no-console
  console.warn(
    `[LOCAL_MODE] enabled — data-local boot. supabase=${usingLocalDb ? 'LOOPBACK ' + LOCAL_SUPABASE_URL_DEFAULT + ' (no hosted DB)' : config.supabaseUrl}` +
      ` · ONLY_ATTESTATIONS_LEAVE=${ONLY_ATTESTATIONS_LEAVE}` +
      ` · LOCAL_LLM_BASE_URL=${LOCAL_LLM_BASE_URL || '(unset — cloud LLM endpoints in use)'}`,
  );
}
