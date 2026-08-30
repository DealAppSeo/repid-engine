// ERC-8004 IdentityRegistry minter for repid_agents.
//
// Target contract: ERC8004IdentityRegistry (UUPS upgradeable, ERC-721+).
//   Source: hyperdag-protocol/packages/contracts/IdentityRegistryUpgradeable.sol
//   Deployed (Base Sepolia, multi-chain vanity): 0x8004A818BFB912233c491871b3d84c89A494BD9e
//
// Key contract semantics:
//   * Mint function is `register(string agentURI) returns (uint256 agentId)`.
//     Permissionless — anyone can call. `msg.sender` becomes token owner.
//   * AgentId is auto-incremented `_lastId++`. Returned as uint256.
//   * Events emitted: Registered(agentId, agentURI, owner) + standard ERC-721
//     Transfer(0x0, owner, tokenId).
//
// This service runs on Sean's Trinity Deployer wallet (0xdf6b8215...) as
// the signer. The deployer becomes the token owner. Each agent's UUID is
// associated server-side (Supabase `repid_agents.id` ↔ uint256 agentId).
import { ethers } from 'ethers';
import type { SupabaseClient } from '@supabase/supabase-js';
import IDENTITY_REGISTRY_ABI from '../contracts/IdentityRegistry.abi.json';

export interface MinterConfig {
  rpcUrl: string;
  contractAddress: string;
  minterPrivateKey: string;
  chainId: number;
  supabase: SupabaseClient;
  agentMetadataBaseUrl?: string; // defaults to https://repid.dev/agents
}

export interface MintRequest {
  agentId: string;
  agentURI?: string; // overrides the default metadata URI
}

export interface MintResult {
  agentId: string;
  tokenId: string;
  txHash: string;
  blockNumber: number;
  chainId: number;
  contractAddress: string;
  gasUsed: string;
  ownerAddress: string;
  agentURI: string;
}

export interface MintStatus {
  minted: boolean;
  tokenId: string | null;
  txHash: string | null;
  blockNumber: number | null;
  chainId: number | null;
  contractAddress: string | null;
  conservatorAddress: string | null;
  basescanUrl: string | null;
}

/**
 * Outcome of the on-chain cross-check. THREE outcomes, never two — the difference
 * between "the chain says no" and "we never reached the chain" is the whole point.
 *
 * NO_TOKEN     no token id recorded here; nothing to look up.
 * OWNER_FOUND  ownerOf() returned an address. A real on-chain fact.
 * REVERTED     ownerOf() REVERTED — the contract answered, and the answer is that no
 *              such token exists. Also a real on-chain fact.
 * NOT_CHECKED  we never got an answer: RPC unreachable, timeout, rate limit, proxy
 *              refusal. NOT a fact about the chain, and must never be reported as one.
 */
export type OnChainCheck = 'NO_TOKEN' | 'OWNER_FOUND' | 'REVERTED' | 'NOT_CHECKED';

export interface OnChainVerification {
  dbTokenId: string | null;
  onChainOwner: string | null;
  dbConservator: string | null;
  drift: boolean;
  reason: string | null;
  check: OnChainCheck;
}

/**
 * Did the CONTRACT answer, or did we never reach it?
 *
 * ethers v6 raises `CALL_EXCEPTION` when the contract itself reverts — that is the chain
 * answering "no such token". Every other code (SERVER_ERROR, NETWORK_ERROR, TIMEOUT,
 * UNKNOWN_ERROR, …) means the call never landed.
 *
 * MEASURED 2026-08-30 from a sandbox whose proxy refuses every public Base RPC:
 *     code = "SERVER_ERROR"   shortMessage = "server response 403 Forbidden"
 *     e.code === 'CALL_EXCEPTION'  ->  false
 * So a blocked or down RPC is plainly distinguishable from a revert, and the previous
 * code did not distinguish them: it labelled EVERY failure `ownerOf reverted` and set
 * `drift: true`. An RPC outage was therefore published as an on-chain finding — the same
 * NOT_CHECKED-scored-as-a-verdict defect that cost twelve days in the settlement path,
 * here in the identity path.
 */
export function classifyOwnerOfError(e: unknown): 'REVERTED' | 'NOT_CHECKED' {
  return (e as { code?: string } | null)?.code === 'CALL_EXCEPTION' ? 'REVERTED' : 'NOT_CHECKED';
}

function basescanTxUrl(chainId: number, txHash: string): string {
  return chainId === 84532
    ? `https://sepolia.basescan.org/tx/${txHash}`
    : `https://basescan.org/tx/${txHash}`;
}

export class Erc8004Minter {
  private provider: ethers.JsonRpcProvider;
  private signer: ethers.Wallet;
  private contract: ethers.Contract;
  private metadataBaseUrl: string;

  constructor(private config: MinterConfig) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.signer = new ethers.Wallet(config.minterPrivateKey, this.provider);
    this.contract = new ethers.Contract(
      config.contractAddress,
      IDENTITY_REGISTRY_ABI,
      this.signer
    );
    this.metadataBaseUrl =
      config.agentMetadataBaseUrl ?? 'https://repid.dev/agents';
  }

  private buildAgentURI(agentId: string, override?: string): string {
    if (override && override.length > 0) return override;
    return `${this.metadataBaseUrl}/${agentId}/metadata`;
  }

  /** Throws if the agent row already has a token_id recorded. */
  async ensureNotAlreadyMinted(agentId: string): Promise<void> {
    const { data, error } = await this.config.supabase
      .from('repid_agents')
      .select('agent_name, erc8004_token_id, mint_tx_hash')
      .eq('id', agentId)
      .single();
    if (error) throw new Error(`agent lookup failed: ${error.message}`);
    // We treat mint_tx_hash as the authoritative "minted in this system"
    // signal. Pre-existing erc8004_token_id without mint_tx_hash is legacy
    // data (e.g. APM) and should NOT block a fresh mint, but should be
    // flagged loudly.
    if (data && data.mint_tx_hash) {
      throw new Error(
        `agent ${data.agent_name} already minted (tx=${data.mint_tx_hash}, token=${data.erc8004_token_id})`
      );
    }
    if (data && data.erc8004_token_id && !data.mint_tx_hash) {
      console.warn(
        `[Erc8004Minter] agent ${data.agent_name} has legacy erc8004_token_id=${data.erc8004_token_id} without mint_tx_hash. Proceeding with fresh mint — caller should reconcile manually.`
      );
    }
  }

  /** Gas estimate for register(string). */
  async estimateGas(req: MintRequest): Promise<bigint> {
    const agentURI = this.buildAgentURI(req.agentId, req.agentURI);
    return (this.contract as any)['register(string)'].estimateGas(agentURI);
  }

  /**
   * Mints a fresh ERC-8004 agent identity. The configured signer wallet
   * (msg.sender) becomes the token owner. The returned agentId (uint256)
   * is stored on repid_agents.erc8004_token_id as a string.
   */
  async mint(req: MintRequest): Promise<MintResult> {
    await this.ensureNotAlreadyMinted(req.agentId);

    const agentURI = this.buildAgentURI(req.agentId, req.agentURI);

    const tx = await (this.contract as any)['register(string)'](agentURI);
    console.log(`[Erc8004Minter] register tx submitted: ${tx.hash}`);

    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error(`register tx failed or reverted: ${tx.hash}`);
    }

    // Extract token_id from the Registered event (preferred) or ERC-721 Transfer.
    const tokenId = this.extractTokenIdFromReceipt(receipt);
    if (tokenId === null) {
      throw new Error(
        `no Registered or Transfer event in tx ${tx.hash} — token_id unknown`
      );
    }

    const ownerAddress = this.signer.address;

    const { error } = await this.config.supabase
      .from('repid_agents')
      .update({
        erc8004_address: this.config.contractAddress,
        erc8004_token_id: tokenId,
        conservator_address: ownerAddress,
        mint_tx_hash: tx.hash,
        mint_block_number: receipt.blockNumber,
        minted_at: new Date().toISOString(),
        mint_chain_id: this.config.chainId,
      })
      .eq('id', req.agentId);
    if (error) throw new Error(`supabase update failed: ${error.message}`);

    return {
      agentId: req.agentId,
      tokenId,
      txHash: tx.hash,
      blockNumber: receipt.blockNumber,
      chainId: this.config.chainId,
      contractAddress: this.config.contractAddress,
      gasUsed: receipt.gasUsed.toString(),
      ownerAddress,
      agentURI,
    };
  }

  private extractTokenIdFromReceipt(receipt: ethers.TransactionReceipt): string | null {
    const registeredTopic = ethers.id('Registered(uint256,string,address)');
    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    for (const log of receipt.logs) {
      if (log.topics[0] === registeredTopic && log.topics[1]) {
        return ethers.toBigInt(log.topics[1]).toString();
      }
    }
    for (const log of receipt.logs) {
      if (
        log.topics[0] === transferTopic &&
        log.topics[1] === ethers.zeroPadValue('0x', 32) && // mint (from = 0x0)
        log.topics[3]
      ) {
        return ethers.toBigInt(log.topics[3]).toString();
      }
    }
    return null;
  }

  async getMintStatus(agentId: string): Promise<MintStatus> {
    const { data, error } = await this.config.supabase
      .from('repid_agents')
      .select(
        'erc8004_token_id, mint_tx_hash, mint_block_number, mint_chain_id, erc8004_address, conservator_address'
      )
      .eq('id', agentId)
      .single();
    if (error) throw new Error(`agent lookup failed: ${error.message}`);
    const minted = !!data?.mint_tx_hash;
    return {
      minted,
      tokenId: data?.erc8004_token_id ?? null,
      txHash: data?.mint_tx_hash ?? null,
      blockNumber: data?.mint_block_number ?? null,
      chainId: data?.mint_chain_id ?? null,
      contractAddress: data?.erc8004_address ?? null,
      conservatorAddress: data?.conservator_address ?? null,
      basescanUrl:
        data?.mint_tx_hash && data?.mint_chain_id
          ? basescanTxUrl(data.mint_chain_id, data.mint_tx_hash)
          : null,
    };
  }

  /**
   * Cross-verifies DB state against on-chain ownerOf. Catches drift
   * between Supabase and chain state.
   */
  async verifyOnChain(agentId: string): Promise<OnChainVerification> {
    const status = await this.getMintStatus(agentId);
    if (!status.tokenId) {
      return {
        dbTokenId: null,
        onChainOwner: null,
        dbConservator: status.conservatorAddress,
        drift: false,
        reason: 'not minted',
        check: 'NO_TOKEN',
      };
    }
    try {
      const owner: string = await (this.contract as any).ownerOf(status.tokenId);
      const driftFromConservator =
        status.conservatorAddress !== null &&
        owner.toLowerCase() !== status.conservatorAddress.toLowerCase();
      return {
        dbTokenId: status.tokenId,
        onChainOwner: owner,
        dbConservator: status.conservatorAddress,
        drift: driftFromConservator,
        reason: driftFromConservator
          ? `on-chain owner ${owner} != db conservator ${status.conservatorAddress}`
          : null,
        check: 'OWNER_FOUND',
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string } | null)?.code;
      if (classifyOwnerOfError(e) === 'REVERTED') {
        // The contract answered: no such token. A real on-chain fact, and real drift
        // against a db row that claims one.
        return {
          dbTokenId: status.tokenId,
          onChainOwner: null,
          dbConservator: status.conservatorAddress,
          drift: true,
          reason: `ownerOf reverted: ${msg}`,
          check: 'REVERTED',
        };
      }
      // We never reached the chain. `drift: false` is deliberate and is the fix: asserting
      // drift here would publish a network failure as a discrepancy with the chain, and a
      // caller resolving UNVERIFIED against this would flip live agents to NOT_MINTED
      // during an RPC outage.
      return {
        dbTokenId: status.tokenId,
        onChainOwner: null,
        dbConservator: status.conservatorAddress,
        drift: false,
        reason: `chain not reached (${code ?? 'no code'}): ${msg}`,
        check: 'NOT_CHECKED',
      };
    }
  }

  getSignerAddress(): string {
    return this.signer.address;
  }
}
