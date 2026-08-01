// HyperDAG → ERC-8004 ReputationRegistry writer.
//
// Writes the HyperDAG protocol's view of an agent's RepID as a feedback
// signal to the canonical ERC-8004 ReputationRegistry. After this lands,
// any ERC-8004-aware consumer can call getSummary() with HyperDAG's
// operator wallet as a `clientAddress` filter and see our score alongside
// other reviewers' signals.
//
// Spec: github.com/erc-8004/erc-8004-contracts — section
//       "Reputation Registry: trust signals".
// Contract verified live on Base Sepolia 2026-05-10 (probe script):
//   - 0x8004B663056A597Dffe9eCcC1965A193B7388713
//   - getVersion() = "2.0.0"
//   - getIdentityRegistry() = 0x8004A818BFB912233c491871b3d84c89A494BD9e (matches canonical)
//
// IMPORTANT — ABI surface deviates from the sprint draft. The deployed
// contract uses `string tag1, string tag2` (NOT bytes32) and the
// giveFeedback signature is 8 params (sprint claimed 7). Code below
// matches the actual ABI as fetched from the canonical repo.
import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getProvider } from '../clients/rpc-with-failover';
import { getActiveNetwork } from '../config/network';
import reputationAbiRaw from '../contracts/ReputationRegistry.abi.json';

const REPUTATION_ABI =
  (reputationAbiRaw as any).abi ?? (reputationAbiRaw as unknown[]);

export interface ReputationWriterConfig {
  rpcUrl?: string;
  privateKey: string;
  contractAddress?: string;
  chainId?: number;
  provider?: ethers.Provider;
}

export interface WriteRepIDArgs {
  agentTokenId: string; // ERC-721 tokenId on IdentityRegistry
  repid: number;        // current RepID 0-10000
  tier: string;         // VETERAN | AUTONOMOUS | ESTABLISHED | EARNING | PROBATIONARY
  endpoint?: string;    // optional HTTP endpoint where feedback context lives
  feedbackURI?: string; // optional off-chain feedback file URL
  feedbackHash?: string; // optional bytes32 integrity hash
}

export interface WriteRepIDResult {
  txHash: string;
  blockNumber: number;
  gasUsed: string;
}

export interface GetSummaryResult {
  count: number;
  summaryValue: bigint;
  summaryValueDecimals: number;
}

export class Erc8004ReputationWriter {
  static readonly DEFAULTS = {
    BASE_SEPOLIA_REPUTATION: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
    BASE_MAINNET_REPUTATION: '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63',
    // Tag values are plain strings per the live ABI (not bytes32 as the
    // sprint draft assumed). Keeping the names familiar so downstream
    // queries can filter consistently.
    TAG_HYPERDAG_REPID: 'hyperdag_repid',
    TAG_TIER_PREFIX: 'tier:',
  };

  private readonly provider: ethers.Provider;
  private readonly wallet: ethers.Wallet;
  private readonly contract: ethers.Contract;
  private readonly contractAddress: string;
  readonly chainId: number;

  constructor(config: ReputationWriterConfig) {
    this.provider = config.provider || new ethers.JsonRpcProvider(config.rpcUrl || 'https://sepolia.base.org');
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    this.chainId = config.chainId ?? 84532;
    this.contractAddress =
      config.contractAddress ??
      Erc8004ReputationWriter.DEFAULTS.BASE_SEPOLIA_REPUTATION;
    this.contract = new ethers.Contract(
      this.contractAddress,
      REPUTATION_ABI,
      this.wallet
    );
  }

  private tierTag(tier: string): string {
    return `${Erc8004ReputationWriter.DEFAULTS.TAG_TIER_PREFIX}${tier}`;
  }

  /**
   * Write an agent's current RepID as a feedback signal.
   * value=RepID (0-10000), valueDecimals=0 (raw integer).
   * Tag1 = "hyperdag_repid", tag2 = "tier:<TIER>".
   */
  async writeRepIDFeedback(args: WriteRepIDArgs): Promise<WriteRepIDResult> {
    const tag1 = Erc8004ReputationWriter.DEFAULTS.TAG_HYPERDAG_REPID;
    const tag2 = this.tierTag(args.tier);
    const endpoint = args.endpoint ?? '';
    const feedbackURI = args.feedbackURI ?? '';
    const feedbackHash = args.feedbackHash ?? ethers.ZeroHash;

    const tx = await (this.contract as any).giveFeedback(
      BigInt(args.agentTokenId),
      BigInt(args.repid),
      0,
      tag1,
      tag2,
      endpoint,
      feedbackURI,
      feedbackHash
    );

    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`giveFeedback tx failed or reverted: ${tx.hash}`);
    }
    return {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
    };
  }

  /**
   * Read HyperDAG's prior feedback summary for an agent.
   * Filters by this writer's wallet address as the clientAddress.
   */
  async readHyperDAGFeedback(
    agentTokenId: string
  ): Promise<GetSummaryResult> {
    const hyperdagWallet = await this.wallet.getAddress();
    const tag1 = Erc8004ReputationWriter.DEFAULTS.TAG_HYPERDAG_REPID;
    const result = await (this.contract as any).getSummary(
      BigInt(agentTokenId),
      [hyperdagWallet],
      tag1,
      '' // tag2 empty = any tier
    );
    return {
      count: Number(result[0]),
      summaryValue: BigInt(result[1]),
      summaryValueDecimals: Number(result[2]),
    };
  }

  /** Gas estimate for the same giveFeedback call shape. */
  async estimateWriteGas(args: {
    agentTokenId: string;
    repid: number;
    tier: string;
  }): Promise<{ gasEstimate: bigint; gasPriceGwei: string }> {
    const tag1 = Erc8004ReputationWriter.DEFAULTS.TAG_HYPERDAG_REPID;
    const tag2 = this.tierTag(args.tier);
    const estimate = await (this.contract as any).giveFeedback.estimateGas(
      BigInt(args.agentTokenId),
      BigInt(args.repid),
      0,
      tag1,
      tag2,
      '',
      '',
      ethers.ZeroHash
    );
    const feeData = await this.provider.getFeeData();
    return {
      gasEstimate: estimate,
      gasPriceGwei: ethers.formatUnits(feeData.gasPrice ?? 0n, 'gwei'),
    };
  }

  getOperatorAddress(): Promise<string> {
    return this.wallet.getAddress();
  }

  getContractAddress(): string {
    return this.contractAddress;
  }
}

/**
 * Lazy singleton factory. Returns null when env vars are missing so the
 * engine can boot without reputation-write credentials (read-only ops
 * via the reputation routes still work conceptually but the actual
 * provider connection requires the rpcUrl).
 *
 * Env var resolution order for the signing key:
 *   1. ERC8004_REPUTATION_WRITER_KEY (purpose-built)
 *   2. ERC8004_MINTER_PRIVATE_KEY (reuse Sprint 6's minter key)
 *   3. ERC8004_OPERATOR_KEY (legacy variant from erc8004-poster.ts)
 */
let _singleton: Erc8004ReputationWriter | null = null;
let _initAttempted = false;

/**
 * Resolve the signing key from the fallback chain, sanitizing the raw env
 * value (trim, strip surrounding quotes, normalize 0x prefix) and validating
 * the strict format BEFORE it reaches `new ethers.Wallet()`. This replaces the
 * prior inline `A || B || C` chain that passed the raw value straight to
 * ethers — a malformed value (whitespace, quotes, wrong length, non-hex) threw
 * the cryptic ethers "invalid private key" TypeError and crash-looped the
 * worker at boot with no indication of which env var was at fault.
 *
 * Behavior:
 *   - No candidate set (or all empty after trim) → returns null. Preserves the
 *     documented soft-disable above (engine boots without reputation creds).
 *   - A candidate IS set but its value fails format validation → throws LOUD,
 *     naming the env var, its fallback rank, and the specific reason. The bad
 *     value is NOT silently skipped to the next candidate (that would hide the
 *     misconfiguration). Mirrors audit-merkle-anchor.ts's trim() precedent,
 *     extended to full validation.
 */
function resolvePrivateKey(): { key: string; sourceVar: string } | null {
  const candidates: Array<{ name: string; rank: number }> = [
    { name: 'ERC8004_REPUTATION_WRITER_KEY', rank: 1 },
    { name: 'ERC8004_MINTER_PRIVATE_KEY', rank: 2 },
    { name: 'ERC8004_OPERATOR_KEY', rank: 3 },
  ];

  for (const { name, rank } of candidates) {
    const raw = process.env[name];
    if (!raw) continue; // unset

    // Trim whitespace, then strip a single layer of surrounding quotes.
    let v = raw.trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1).trim();
    }
    if (v.length === 0) continue; // empty after cleanup → treat as unset (matches prior `||` semantics)

    // Add 0x prefix if missing AND the remaining string is exactly 64 hex chars.
    if (!v.startsWith('0x') && /^[0-9a-fA-F]{64}$/.test(v)) {
      v = '0x' + v;
    }

    // Strict format gate: 0x + 64 hex chars (66 total).
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) {
      throw new Error(
        `[Erc8004ReputationWriter] FATAL: private key from ${name} (fallback rank ${rank}) failed format validation: ${describeBadKey(v)}`
      );
    }

    console.log(
      `[Erc8004ReputationWriter] private key resolved from ${name} (format validated)`
    );
    return { key: v, sourceVar: name };
  }

  return null; // no candidate present
}

function describeBadKey(v: string): string {
  if (v.length === 0) return 'value is empty after trim';
  if (v.length !== 66) return `length is ${v.length}, expected 66 (0x + 64 hex chars)`;
  if (!v.startsWith('0x')) return 'missing 0x prefix';
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) return 'contains non-hex characters or is malformed';
  return 'unknown format issue';
}

export function getReputationWriter(): Erc8004ReputationWriter | null {
  if (_initAttempted) return _singleton;
  _initAttempted = true;
  const net = getActiveNetwork();
  const resolved = resolvePrivateKey();
  if (!resolved) {
    console.warn(
      '[erc8004-reputation] No signing key env var set (ERC8004_REPUTATION_WRITER_KEY / ERC8004_MINTER_PRIVATE_KEY / ERC8004_OPERATOR_KEY); reputation writes disabled.'
    );
    return null;
  }
  _singleton = new Erc8004ReputationWriter({
    provider: getProvider(),
    privateKey: resolved.key,
    contractAddress: process.env.ERC8004_REPUTATION_CONTRACT || net.contracts.reputationRegistry,
    chainId: net.chainId,
  });
  return _singleton;
}

// Test hook — only used by jest to force a clean singleton re-init.
export function __resetReputationWriterForTests(): void {
  _singleton = null;
  _initAttempted = false;
}

/**
 * Helper to persist a successful write to Supabase (caller wires this in).
 */
export async function persistReputationWrite(
  supabase: SupabaseClient,
  args: {
    agent_id: string;
    agent_token_id: string;
    repid_value: number;
    tier: string;
    tx_hash: string;
    block_number: number;
    gas_used: string;
    chain_id: number;
    contract_address: string;
    repid_event_id?: number;
    /**
     * The service_contract whose settlement caused this write.
     *
     * Until 2026-08-01 this was recorded ONLY inside
     * `repid_events.event_data`, so the link existed but lived in a JSON blob
     * no index or foreign key could reach — the trust receipt had to say "this
     * is the provider's latest write, not proven caused by this exchange".
     * Recording it as a column is what lets a receipt make the causal claim
     * honestly.
     */
    contract_id?: string | null;
  }
): Promise<void> {
  const { error } = await supabase.from('erc8004_reputation_writes').insert(args);
  if (error) {
    // An unchecked insert here is how the on-chain audit trail silently drifts
    // from the chain. The transfer already happened; failing to record it is
    // not fatal to the payment, but it must never pass in silence.
    console.error(
      `[erc8004] FAILED to persist the reputation write for tx ${args.tx_hash} ` +
        `(agent ${args.agent_id}): ${error.message}. The on-chain write SUCCEEDED — ` +
        `the ledger is now behind the chain and needs reconciling.`
    );
  }
}
