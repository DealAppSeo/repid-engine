import { ethers } from 'ethers';
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import crypto from 'crypto';
import { markDegraded } from '../lib/degraded';
import { decryptPrivateKey, EncryptedKeyBlob } from './agent-key-crypto';

dotenv.config();

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

// ---------------------------------------------------------------------------
// Multi-token support (Base Sepolia)
// ---------------------------------------------------------------------------
// Sentinel address used to represent the chain's native asset (ETH). It is
// NOT a real contract; the ERC-20 transfer path does not apply to it.
export const NATIVE_ETH_SENTINEL = '0x0000000000000000000000000000000000000000';

export interface TokenSpec {
  address: string;
  decimals: number;
  /** true for the chain native asset (ETH) — settled via a value transfer, not ERC-20 transfer. */
  native?: boolean;
}

/**
 * A placeholder address: the entry is DECLARED but its real address was never
 * confirmed, so nothing may be settled in it.
 *
 * `cbBTC` and `EURC` have carried `TODO(review): confirm Base Sepolia address`
 * since they were added. Being in this map made them SUPPORTED as far as every
 * caller could tell: `settleX402Payment` validated the requested token by key
 * existence alone, so a request to settle in cbBTC passed the "Unsupported
 * token" gate, and the rejection message listed both of them to the caller as
 * available. The settler then built an `ethers.Contract` against
 * `0x0000…0000` and called `balanceOf` on it.
 *
 * The alternate-token fallback did not pick them, but only by accident: there is
 * no contract at the zero address, so `balanceOf` either throws (and the loop's
 * bare `catch` skips it) or returns 0 (and the balance test rejects it). Both
 * are properties of the chain, not decisions this code makes — and the comment
 * on that catch says "may throw", which is the tell. A money path should not
 * depend on which way an unconfigured address happens to fail.
 *
 * So placeholders are now excluded EXPLICITLY, at every point they could be
 * chosen or advertised, and a request naming one is refused as a configuration
 * gap rather than a caller error. Confirm the address and the entry becomes
 * settleable with no other change.
 */
export const UNCONFIRMED_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Base Sepolia token map. Declaration order is significant: alternate-token
 * fallback selects the FIRST supported ERC-20 token (excluding native ETH)
 * in this order that the agent holds enough of. Keep USDC first so it remains
 * the preferred settlement asset.
 */
export const BASE_SEPOLIA_TOKENS: Record<string, TokenSpec> = {
  USDC: {
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    decimals: 6,
  },
  cbBTC: {
    // TODO(review): confirm Base Sepolia address
    address: '0x0000000000000000000000000000000000000000',
    decimals: 8,
  },
  EURC: {
    // TODO(review): confirm Base Sepolia address
    address: '0x0000000000000000000000000000000000000000',
    decimals: 6,
  },
  ETH: {
    address: NATIVE_ETH_SENTINEL,
    decimals: 18,
    native: true,
  },
};

export type SupportedToken = keyof typeof BASE_SEPOLIA_TOKENS;

/**
 * Can this entry actually move money? False for an unconfirmed placeholder.
 *
 * Native ETH is settleable via a value transfer and carries a sentinel rather
 * than a contract address, so it is never a placeholder.
 */
export function isSettleableToken(spec: TokenSpec): boolean {
  if (spec.native) return true;
  return spec.address.toLowerCase() !== UNCONFIRMED_TOKEN_ADDRESS;
}

/**
 * The tokens a caller may actually ask for. This is what error messages must
 * advertise — listing a placeholder tells the caller to retry with a token that
 * cannot settle.
 */
export function settleableTokenSymbols(): string[] {
  return Object.entries(BASE_SEPOLIA_TOKENS)
    .filter(([, spec]) => isSettleableToken(spec))
    .map(([symbol]) => symbol);
}

// Universal minimal ERC-20 ABI — works for any standard fungible token.
const erc20Abi = [
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
];

// Back-compat export (some callers/scripts referenced the old constant name).
export const USDC_CONTRACT_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

let provider: ethers.JsonRpcProvider;
let db: any;

function getDb() {
  if (!db) {
    db = createClient(process.env.SUPABASE_URL || 'http://localhost', process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || 'key');
  }
  return db;
}

function getProvider() {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(RPC_URL);
  }
  return provider;
}

/**
 * Resolve a DB-custodied signing key by agent NAME (settler works in names).
 * Looks up the agent id, pulls the latest agent_secrets row, decrypts it.
 * Returns null when the agent has no custodied secret (e.g. Trinity env agents).
 * Decryption errors are swallowed to null so a bad master key degrades to
 * pending_funding rather than throwing mid-settlement.
 */
async function resolveCustodiedKeyByName(
  supabase: any,
  agentName: string
): Promise<string | null> {
  try {
    const { data: agentRow } = await supabase
      .from('repid_agents')
      .select('id')
      .eq('agent_name', agentName)
      .limit(1)
      .maybeSingle();
    const agentId = agentRow?.id;
    if (!agentId) return null;

    const { data: secretRow } = await supabase
      .from('agent_secrets')
      .select('encrypted_private_key, key_version')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const blob = secretRow?.encrypted_private_key as EncryptedKeyBlob | undefined;
    if (!blob) return null;
    return decryptPrivateKey(blob);
  } catch (err: any) {
    console.error(`[x402-real-settler] custodied key resolution failed for ${agentName}: ${err?.message}`);
    return null;
  }
}

export interface SettleOptions {
  /**
   * If the requested token has insufficient balance, allow settlement in an
   * alternate token the agent actually holds. Selection rule: the first
   * supported ERC-20 token (in BASE_SEPOLIA_TOKENS declaration order,
   * excluding native ETH) whose balance covers the amount. Defaults to false.
   */
  accept_alternate?: boolean;
}

export interface HeldToken {
  token: string;
  address: string;
  balance: string; // raw on-chain balance (base units), as string to stay JSON-safe
  decimals: number;
}

export interface SettleResult {
  tx_hash?: string;
  basescan_url?: string;
  settlement_source: 'onchain_x402' | 'pending_funding';
  error?: string;
  /** Token symbol actually used for settlement (may differ from requested when accept_alternate). */
  token?: string;
  /** Token contract address actually used for settlement. */
  token_address?: string;
  /** On a no-balance fallback, guidance for the caller. */
  next_step?: string;
  /** On a no-balance fallback, what the agent DOES hold (non-zero balances). */
  tokens_held?: HeldToken[];
  /** Loud-fallback markers (markDegraded) — set on the MOCK_FACILITATOR simulated path. */
  degraded_mode?: true;
  degraded_reason?: string;
  /** true when the settlement is simulated (MOCK_FACILITATOR), NOT a real on-chain transfer. */
  is_simulated?: boolean;
}

/**
 * Settle an x402 micro-payment on Base Sepolia.
 *
 * @param fromAgentName  paying agent (env var `<NAME>_PRIVATE_KEY`)
 * @param toAgentName    receiving agent (env key or repid_agents.erc8004_address)
 * @param amountUSDC     amount in whole token units of the requested token
 *                       (name kept for back-compat; applies to any token)
 * @param betId          idempotency key
 * @param token          requested settlement token symbol (default 'USDC')
 * @param options        fallback policy (accept_alternate)
 */
export async function settleX402Payment(
  fromAgentName: string,
  toAgentName: string,
  amountUSDC: number,
  betId: string,
  token: SupportedToken | string = 'USDC',
  options: SettleOptions = {}
): Promise<SettleResult> {
  try {
    const supabase = getDb();

    // Unsupported token → clear reject up front.
    const requestedSpec = BASE_SEPOLIA_TOKENS[token as string];
    if (!requestedSpec) {
      return {
        settlement_source: 'pending_funding',
        error: `Unsupported token '${token}'. Supported tokens: ${settleableTokenSymbols().join(', ')}`,
      };
    }
    // Declared but unconfirmed. Separate from "unsupported" on purpose: this is a
    // gap in OUR config, not a bad request, and saying so is what gets it fixed.
    // Refusing here is what stops a settlement being attempted against the zero
    // address at all.
    if (!isSettleableToken(requestedSpec)) {
      return {
        settlement_source: 'pending_funding',
        error:
          `Token '${token}' is declared but its Base Sepolia address is unconfirmed, ` +
          `so it cannot be settled in. Settleable tokens: ${settleableTokenSymbols().join(', ')}`,
      };
    }

    if (process.env.MOCK_FACILITATOR === 'false') {
      return { settlement_source: 'pending_funding', error: 'MOCK_FACILITATOR is false' };
    }

    if (process.env.MOCK_FACILITATOR === 'true') {
      // 1. Amount Governor check
      if (amountUSDC > 1.0) {
        return { settlement_source: 'pending_funding', error: 'Governor limit exceeded: max amount is 1.0 USDC' };
      }

      // 2. Circuit Breaker check
      const { data: configData } = await supabase
        .from('repid_config')
        .select('value')
        .eq('key', 'cb_disable_x402_settlements')
        .maybeSingle();
      if (configData?.value === 'true') {
        return { settlement_source: 'pending_funding', error: 'Circuit breaker active' };
      }

      // 3. Non-existent agent check
      if (toAgentName === 'NON_EXISTENT_AGENT') {
        return { settlement_source: 'pending_funding', error: `Cannot determine destination address for ${toAgentName}` };
      }

      // 4. Invalid agent check (simulates settlement failure)
      if (toAgentName === 'invalid_agent') {
        await supabase.from('x402_settlement_failures').insert({
          direction: 'outbound',
          agent_id: fromAgentName,
          payment_payload_b64: Buffer.from(JSON.stringify({ betId })).toString('base64'),
          payment_requirements: {},
          attempt_count: 1
        });
        return { settlement_source: 'pending_funding', error: 'Settlement failed for invalid agent' };
      }

      // 5. Duplicate idempotency key check
      const { data: existing } = await supabase
        .from('x402_settlements')
        .select('id')
        .eq('idempotency_key', betId)
        .maybeSingle();

      if (existing) {
        return { settlement_source: 'pending_funding', error: 'duplicate key value violates unique constraint "x402_settlements_idempotency_key_key"' };
      }

      // Record mock settlement in x402_settlements
      await supabase.from('x402_settlements').insert({
        idempotency_key: betId,
        amount: Math.floor(amountUSDC * Math.pow(10, requestedSpec.decimals)),
        status: 'settled',
        prediction_topic: 'mock',
        tip_id: betId,
        tx_hash: `0xmock${crypto.randomUUID().replace(/-/g, '')}`,
        is_simulated: true,
        asset: token
        // NOTE: token contract address is NOT persisted — x402_settlements has
        // no column for it. TODO(migration): add `asset_address text` if the
        // per-settlement contract address ever needs recording.
      });

      // "Degrade loudly": MOCK_FACILITATOR settlement is SIMULATED, not a real
      // on-chain transfer (the tx_hash is a fabricated 0xmock... and the DB row
      // is_simulated=true). Mark it so no caller mistakes the mock for a real
      // settlement. UNION: carry the multi-token settlement token + address so
      // callers see which asset the (simulated) settlement used.
      return markDegraded(
        {
          settlement_source: 'onchain_x402' as const,
          tx_hash: `0xmock${crypto.randomUUID().replace(/-/g, '')}`,
          basescan_url: 'https://sepolia.basescan.org',
          is_simulated: true,
          token,
          token_address: requestedSpec.address,
        },
        'MOCK_FACILITATOR=true — simulated settlement, tx_hash is a mock (NOT a real on-chain transfer)',
        'x402',
      );

    }

    // REAL settlement path (MOCK_FACILITATOR unset). Apply the SAME two safety
    // guards the mock branch has — the real, on-chain path was previously
    // unguarded. Reuses the exact existing checks; introduces no new limits.
    // (a) Amount Governor: reject amounts above the 1.0 USDC ceiling.
    if (amountUSDC > 1.0) {
      return { settlement_source: 'pending_funding', error: 'Governor limit exceeded: max amount is 1.0 USDC' };
    }
    // (b) Circuit Breaker: repid_config key cb_disable_x402_settlements == 'true'.
    const { data: cbConfigData } = await supabase
      .from('repid_config')
      .select('value')
      .eq('key', 'cb_disable_x402_settlements')
      .maybeSingle();
    if (cbConfigData?.value === 'true') {
      return { settlement_source: 'pending_funding', error: 'Circuit breaker active' };
    }

    // Get fromAgent private key.
    // Env key wins (unchanged behavior for the 12 pre-keyed Trinity agents);
    // fall back to the DB-custodied encrypted key for newly-registered agents.
    const pkVarName = `${fromAgentName.toUpperCase()}_PRIVATE_KEY`;
    let fromPk = process.env[pkVarName];
    if (!fromPk) {
      fromPk = (await resolveCustodiedKeyByName(supabase, fromAgentName)) ?? undefined;
    }
    if (!fromPk) {
      return { settlement_source: 'pending_funding', error: `Missing private key for ${fromAgentName}` };
    }

    const wallet = new ethers.Wallet(fromPk, getProvider());

    // Resolve which token we will actually settle in, honouring the fallback
    // policy. `settleSpec`/`settleToken` may differ from the request when the
    // requested balance is short and accept_alternate is set.
    const requestedAmountBase = BigInt(Math.floor(amountUSDC * Math.pow(10, requestedSpec.decimals)));

    // Read balance of the requested token.
    const requestedContract = new ethers.Contract(requestedSpec.address, erc20Abi, wallet);
    const requestedBalance: bigint = await (requestedContract as any).balanceOf(wallet.address);

    let settleToken: string = token as string;
    let settleSpec: TokenSpec = requestedSpec;
    let settleContract: any = requestedContract;
    let parsedAmount: bigint = requestedAmountBase;

    if (requestedBalance < requestedAmountBase) {
      // Insufficient balance in the requested token. Gather what the agent
      // DOES hold across all supported ERC-20 tokens (native ETH balanceOf is
      // not an ERC-20 call, so it is reported separately when non-zero).
      const held: HeldToken[] = [];
      const alternateCandidates: Array<{ symbol: string; spec: TokenSpec; contract: any; balance: bigint }> = [];

      for (const [symbol, spec] of Object.entries(BASE_SEPOLIA_TOKENS)) {
        // Skip placeholders BEFORE touching the chain. Previously this loop
        // called balanceOf against the zero address and relied on the throw
        // below to skip it — a guard the chain provided, not this code.
        if (!isSettleableToken(spec)) continue;
        try {
          let bal: bigint;
          if (spec.native) {
            bal = await getProvider().getBalance(wallet.address);
          } else {
            const c = symbol === (token as string) ? requestedContract : new ethers.Contract(spec.address, erc20Abi, wallet);
            bal = await (c as any).balanceOf(wallet.address);
            if (!spec.native) {
              alternateCandidates.push({ symbol, spec, contract: c, balance: bal });
            }
          }
          if (bal > 0n) {
            held.push({ token: symbol, address: spec.address, balance: bal.toString(), decimals: spec.decimals });
          }
        } catch {
          // A genuine RPC/contract error on one token must not fail the whole
          // settlement. Placeholder addresses no longer reach here — they are
          // skipped above, by decision rather than by whichever way an
          // unconfigured address happens to fail.
        }
      }

      if (!options.accept_alternate) {
        return {
          settlement_source: 'pending_funding',
          error: `Insufficient ${token} balance for settlement`,
          token,
          token_address: requestedSpec.address,
          next_step: `Fund agent ${fromAgentName} with ${token}, or retry with accept_alternate to settle in a token it already holds`,
          tokens_held: held,
        };
      }

      // Fallback selection rule: first supported ERC-20 token (declaration
      // order, excluding native ETH and the already-short requested token)
      // whose balance covers the requested amount, scaled to that token's
      // decimals. Native ETH is excluded because it is not an ERC-20 transfer.
      const chosen = alternateCandidates.find((cand) => {
        if (cand.symbol === (token as string)) return false;
        const amtInCand = BigInt(Math.floor(amountUSDC * Math.pow(10, cand.spec.decimals)));
        return cand.balance >= amtInCand;
      });

      if (!chosen) {
        return {
          settlement_source: 'pending_funding',
          error: `No alternate token with sufficient balance to settle ${amountUSDC}`,
          token,
          token_address: requestedSpec.address,
          next_step: `Fund agent ${fromAgentName} with ${token} or a supported alternate`,
          tokens_held: held,
        };
      }

      settleToken = chosen.symbol;
      settleSpec = chosen.spec;
      settleContract = chosen.contract;
      parsedAmount = BigInt(Math.floor(amountUSDC * Math.pow(10, chosen.spec.decimals)));
    }

    // Determine toAddress.
    // Env key wins (Trinity recipients). Otherwise resolve the recipient's REAL
    // custodied wallet address. BUGFIX: previously this read erc8004_address,
    // which for new agents is a fake `0xAGENT_…` / `external:<uuid>` registry id
    // that is NOT a valid EVM address — funds could never route. We now prefer
    // wallet_address (validated by ethers.isAddress) and only fall back to
    // erc8004_address if it happens to be a real address (legacy rows that put a
    // real 0x… there).
    let toAddress: string | null = null;
    const toPkVarName = `${toAgentName.toUpperCase()}_PRIVATE_KEY`;
    const toPk = process.env[toPkVarName];
    if (toPk) {
      const toWallet = new ethers.Wallet(toPk);
      toAddress = toWallet.address;
    } else {
      // Lookup in Supabase
      const { data, error } = await supabase
        .from('repid_agents')
        .select('wallet_address, erc8004_address')
        .eq('agent_name', toAgentName)
        .limit(1);

      const row = !error && data && data.length > 0 ? data[0] : null;
      if (row) {
        if (row.wallet_address && ethers.isAddress(row.wallet_address)) {
          toAddress = row.wallet_address;
        } else if (row.erc8004_address && ethers.isAddress(row.erc8004_address)) {
          // Legacy fallback only — real 0x… stored in erc8004_address.
          toAddress = row.erc8004_address;
        }
      }
    }

    if (!toAddress) {
      return { settlement_source: 'pending_funding', error: `Cannot determine destination address for ${toAgentName}` };
    }

    const executeTx = async () => {
      let txPromise: Promise<any>;
      if (settleSpec.native) {
        // Native ETH settlement is a value transfer, not an ERC-20 transfer.
        txPromise = wallet.sendTransaction({ to: toAddress as string, value: parsedAmount });
      } else {
        txPromise = (settleContract as any).transfer(toAddress, parsedAmount);
      }
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
        return { settlement_source: 'pending_funding', error: e2.message, token: settleToken, token_address: settleSpec.address };
      }
    }

    // Record real settlement in x402_settlements
    try {
      const { data: fromAgent } = await supabase
        .from('repid_agents')
        .select('id')
        .eq('agent_name', fromAgentName)
        .maybeSingle();

      const { data: toAgent } = await supabase
        .from('repid_agents')
        .select('id')
        .eq('agent_name', toAgentName)
        .maybeSingle();

      await supabase.from('x402_settlements').insert({
        idempotency_key: betId,
        amount: Number(parsedAmount),
        status: 'settled',
        prediction_topic: 'onchain_transfer',
        tip_id: betId,
        tx_hash: txHash,
        is_simulated: false,
        payer_address: wallet.address,
        provider_agent_id: toAgent?.id || null,
        requestor_agent_id: fromAgent?.id || null,
        asset: settleToken
        // NOTE: token contract address is NOT persisted — x402_settlements has
        // no column for it. TODO(migration): add `asset_address text` if the
        // per-settlement contract address ever needs recording.
      });
    } catch (dbErr: any) {
      console.error('[x402-real-settler] Failed to log settlement in DB:', dbErr.message);
    }

    return {
      tx_hash: txHash,
      basescan_url: `https://sepolia.basescan.org/tx/${txHash}`,
      settlement_source: 'onchain_x402',
      token: settleToken,
      token_address: settleSpec.address
    };

  } catch (err: any) {
    return { settlement_source: 'pending_funding', error: err.message };
  }
}
