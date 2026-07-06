// On-chain stake service — canonical RepIDStaking path (Base Sepolia).
//
// Target contract: RepIDStaking (contracts/RepIDStaking.sol). Native-ETH
// staking, MIN_STAKE = 0.0001 ETH, ERC-8004 IdentityRegistry-linked.
//
//   * stake(uint256 agentId, uint256 decisionHash) payable — msg.value >= MIN_STAKE.
//   * emits Staked(uint256 indexed stakeId, uint256 agentId, uint256 amount, uint256 decisionHash).
//   * getStake(uint256 stakeId) view returns (Stake) — struct incl. staker/agentId/amount/status.
//
// The deployed contract address is read from Supabase `repid_config`
// (key='staking_contract_address'), written by scripts/deploy_staking.js.
//
// READ-ONLY: this service never signs or sends. It (a) returns the contract
// address + calldata + MIN_STAKE so a CLIENT wallet signs & sends the stake,
// and (b) verifies a stake given a tx hash by reading the Staked event on
// Base Sepolia. No private key is required, read, or printed.
import { ethers } from 'ethers';
import { getProvider } from '../clients/rpc-with-failover';
import { getActiveNetwork } from '../config/network';
import { db } from '../db';

// Minimal ABI — only what the read/verify/calldata paths need. Mirrors
// contracts/RepIDStaking.sol exactly (verify before touching: RULE-5).
export const REPID_STAKING_ABI = [
  'function stake(uint256 agentId, uint256 decisionHash) payable',
  'function MIN_STAKE() view returns (uint256)',
  'function getStake(uint256 stakeId) view returns (tuple(address staker, uint256 agentId, uint256 amount, uint256 decisionHash, uint8 status, uint256 stakedAt))',
  'event Staked(uint256 indexed stakeId, uint256 agentId, uint256 amount, uint256 decisionHash)',
] as const;

// Fallback MIN_STAKE mirrors the on-chain constant (0.0001 ETH). Used only
// when the live contract read is unavailable; the on-chain value wins when
// the contract is deployed + reachable.
export const MIN_STAKE_WEI_FALLBACK = ethers.parseEther('0.0001');

export const CONFIG_KEY_STAKING_ADDRESS = 'staking_contract_address';

export interface StakingContractInfo {
  contractAddress: string;
  minStakeWei: string;
  chainId: number;
  network: string;
}

export interface StakeCalldata {
  contractAddress: string;
  chainId: number;
  minStakeWei: string;
  /** ABI-encoded stake(agentId, decisionHash) calldata for a client wallet. */
  data: string;
  /** The uint256 on-chain agentId the calldata encodes. */
  onChainAgentId: string;
  /** The uint256 decisionHash the calldata encodes. */
  decisionHash: string;
}

export interface VerifiedStake {
  verified: boolean;
  reason: string | null;
  txHash: string;
  stakeId: string | null;
  onChainAgentId: string | null;
  amountWei: string | null;
  decisionHash: string | null;
  contractAddress: string | null;
  blockNumber: number | null;
  basescanUrl: string;
}

function basescanTxUrl(chainId: number, txHash: string): string {
  return chainId === 84532
    ? `https://sepolia.basescan.org/tx/${txHash}`
    : `https://basescan.org/tx/${txHash}`;
}

/**
 * Read the deployed RepIDStaking address from repid_config. Returns null when
 * the row is absent (contract not deployed yet) so callers can degrade
 * gracefully instead of throwing.
 */
export async function getStakingContractAddress(): Promise<string | null> {
  const { data, error } = await db
    .from('repid_config')
    .select('value')
    .eq('key', CONFIG_KEY_STAKING_ADDRESS)
    .maybeSingle();
  if (error || !data) return null;
  const value = (data as any).value;
  if (typeof value !== 'string' || !ethers.isAddress(value)) return null;
  return ethers.getAddress(value);
}

/**
 * Live MIN_STAKE from the deployed contract; falls back to the compile-time
 * constant (0.0001 ETH) when the contract is undeployed or unreachable.
 */
export async function getMinStakeWei(contractAddress: string | null): Promise<bigint> {
  if (!contractAddress) return MIN_STAKE_WEI_FALLBACK;
  try {
    const provider = getProvider();
    const contract = new ethers.Contract(contractAddress, REPID_STAKING_ABI, provider);
    const min: bigint = await (contract as any).MIN_STAKE();
    return min;
  } catch {
    return MIN_STAKE_WEI_FALLBACK;
  }
}

/**
 * Contract info a client needs to build + send a stake: address, min stake,
 * chain, network. Returns contractAddress=null when undeployed.
 */
export async function getStakingContractInfo(): Promise<StakingContractInfo> {
  const net = getActiveNetwork();
  const contractAddress = await getStakingContractAddress();
  const minStakeWei = await getMinStakeWei(contractAddress);
  return {
    contractAddress: contractAddress ?? '',
    minStakeWei: minStakeWei.toString(),
    chainId: net.chainId,
    network: net.name === 'Base Sepolia' ? 'base-sepolia' : net.name.toLowerCase().replace(/\s+/g, '-'),
  };
}

/**
 * Deterministically map our string agentId (Supabase uuid) to the uint256
 * agentId the contract expects. keccak256(utf8(agentId)) as uint256 — stable,
 * collision-resistant, and reproducible client-side for cross-checking.
 */
export function toOnChainAgentId(agentId: string): bigint {
  return ethers.toBigInt(ethers.id(agentId));
}

/**
 * Build the stake() calldata + address so a client wallet can sign & send.
 * `decisionHash` defaults to 0 (a plain capability stake with no linked
 * decision); a caller may pass a specific decision hash.
 */
export async function buildStakeCalldata(
  agentId: string,
  decisionHash: bigint = 0n,
): Promise<StakeCalldata | null> {
  const net = getActiveNetwork();
  const contractAddress = await getStakingContractAddress();
  if (!contractAddress) return null;
  const minStakeWei = await getMinStakeWei(contractAddress);
  const onChainAgentId = toOnChainAgentId(agentId);
  const iface = new ethers.Interface(REPID_STAKING_ABI);
  const data = iface.encodeFunctionData('stake', [onChainAgentId, decisionHash]);
  return {
    contractAddress,
    chainId: net.chainId,
    minStakeWei: minStakeWei.toString(),
    data,
    onChainAgentId: onChainAgentId.toString(),
    decisionHash: decisionHash.toString(),
  };
}

/**
 * Verify a stake on-chain: confirm the given tx hash contains a `Staked`
 * event emitted BY the deployed RepIDStaking contract FOR this agent.
 *
 * The event's agentId is matched against keccak256(agentId) (toOnChainAgentId).
 * Returns verified=false with a reason on any mismatch — never throws for the
 * "not a valid stake" cases (RULE-8, callers gate on `verified`).
 */
export async function verifyStakeOnChain(
  agentId: string,
  txHash: string,
): Promise<VerifiedStake> {
  const net = getActiveNetwork();
  const url = basescanTxUrl(net.chainId, txHash);
  const base: VerifiedStake = {
    verified: false,
    reason: null,
    txHash,
    stakeId: null,
    onChainAgentId: null,
    amountWei: null,
    decisionHash: null,
    contractAddress: null,
    blockNumber: null,
    basescanUrl: url,
  };

  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { ...base, reason: 'malformed tx hash (expected 0x + 64 hex)' };
  }

  const contractAddress = await getStakingContractAddress();
  if (!contractAddress) {
    return { ...base, reason: 'staking contract not deployed (no staking_contract_address in repid_config)' };
  }

  const expectedAgentId = toOnChainAgentId(agentId);
  const stakedTopic = ethers.id('Staked(uint256,uint256,uint256,uint256)');
  const iface = new ethers.Interface(REPID_STAKING_ABI);

  let receipt: ethers.TransactionReceipt | null;
  try {
    const provider = getProvider();
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (e: unknown) {
    return { ...base, contractAddress, reason: `rpc error fetching receipt: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!receipt) {
    return { ...base, contractAddress, reason: 'transaction not found or not yet mined' };
  }
  if (receipt.status !== 1) {
    return { ...base, contractAddress, blockNumber: receipt.blockNumber, reason: 'transaction reverted (status != 1)' };
  }

  // Find a Staked log emitted by OUR contract for THIS agent.
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contractAddress.toLowerCase()) continue;
    if (log.topics[0] !== stakedTopic) continue;
    let parsed: ethers.LogDescription | null;
    try {
      parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    const evAgentId = ethers.toBigInt(parsed.args[1]);
    if (evAgentId !== expectedAgentId) continue; // Staked event, but for a different agent
    return {
      verified: true,
      reason: null,
      txHash,
      stakeId: ethers.toBigInt(parsed.args[0]).toString(),
      onChainAgentId: evAgentId.toString(),
      amountWei: ethers.toBigInt(parsed.args[2]).toString(),
      decisionHash: ethers.toBigInt(parsed.args[3]).toString(),
      contractAddress,
      blockNumber: receipt.blockNumber,
      basescanUrl: url,
    };
  }

  return {
    ...base,
    contractAddress,
    blockNumber: receipt.blockNumber,
    reason: 'no Staked event for this agent in tx (wrong contract, wrong agent, or not a stake tx)',
  };
}
