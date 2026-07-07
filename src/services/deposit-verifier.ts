/**
 * Deposit verifier — verified-deposit escrow model.
 *
 * When REAL_STAKING_ENABLED is on, a stake deposit is only recorded as REAL
 * after the claimed on-chain USDC transfer is verified on Base Sepolia. A
 * verified deposit must satisfy ALL of:
 *
 *   1. token       — the transfer moved the canonical USDC token
 *                    (config.usdcTokenAddress), not some other ERC-20.
 *   2. recipient   — the tokens landed at the known escrow address
 *                    (config.stakeEscrowAddress).
 *   3. amount      — the transferred value is >= the claimed amount.
 *   4. confirmed   — the tx is mined and has >= stakeMinConfirmations
 *                    confirmations.
 *   5. balance     — balanceOf(escrow) increased by >= the claimed amount
 *                    across the deposit block (belt-and-suspenders vs. a
 *                    forged/re-entrant Transfer log).
 *
 * The ethers provider is injectable so this module is unit-testable without a
 * live RPC (see tests/reponomics-real-staking.test.ts).
 *
 * Duplicate / replayed tx_hash detection is NOT done here — it is a DB
 * uniqueness check in stake-vault (a tx_hash already recorded as a real stake
 * is rejected before we ever hit the chain).
 */

import { ethers } from 'ethers';
import { config } from '../config';

// ERC-20 Transfer event signature + balanceOf, the only surface we touch.
const ERC20_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function balanceOf(address owner) view returns (uint256)',
];

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

export interface VerifyDepositInput {
  txHash: string;
  claimedAmount: bigint; // USDC smallest unit (6 decimals)
  escrowAddress: string;
  tokenAddress: string;
  minConfirmations: number;
}

export interface VerifyDepositResult {
  verified: boolean;
  reason?: string;
  observedAmount?: bigint;
  confirmations?: number;
  blockNumber?: number;
}

/**
 * Minimal shape of the provider surface we need. Any object that implements
 * these (a real ethers.JsonRpcProvider, or a test double) works.
 */
export interface EthProviderLike {
  getTransactionReceipt(txHash: string): Promise<ethers.TransactionReceipt | null>;
  getBlockNumber(): Promise<number>;
  call(tx: { to: string; data: string; blockTag?: ethers.BlockTag }): Promise<string>;
}

let providerFactory: () => EthProviderLike = () =>
  new ethers.JsonRpcProvider(config.baseSepoliaRpc) as unknown as EthProviderLike;

/** Test seam: swap in a mock provider factory. Call with undefined to reset. */
export function __setProviderFactory(f?: () => EthProviderLike): void {
  providerFactory = f
    ? f
    : () => new ethers.JsonRpcProvider(config.baseSepoliaRpc) as unknown as EthProviderLike;
}

const iface = new ethers.Interface(ERC20_ABI);

function eqAddr(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  try {
    return ethers.getAddress(a) === ethers.getAddress(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/**
 * Verify an on-chain USDC deposit into the escrow. Returns verified:false with
 * a reason for any failing condition; never throws for an expected rejection.
 */
export async function verifyDeposit(input: VerifyDepositInput): Promise<VerifyDepositResult> {
  const { txHash, claimedAmount, escrowAddress, tokenAddress, minConfirmations } = input;

  if (!txHash || typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return { verified: false, reason: 'invalid or missing tx_hash' };
  }
  if (!escrowAddress) return { verified: false, reason: 'escrow address not configured' };
  if (!tokenAddress) return { verified: false, reason: 'token address not configured' };
  if (claimedAmount <= 0n) return { verified: false, reason: 'claimed amount must be positive' };

  const provider = providerFactory();

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (e: any) {
    return { verified: false, reason: `rpc error fetching receipt: ${e?.message ?? e}` };
  }
  if (!receipt) {
    return { verified: false, reason: 'tx not found (unmined or unknown)' };
  }
  // status 0 = reverted; null/undefined pre-Byzantium is not expected on Base.
  if ((receipt as any).status === 0) {
    return { verified: false, reason: 'tx reverted' };
  }

  // Confirmations.
  let head: number;
  try {
    head = await provider.getBlockNumber();
  } catch (e: any) {
    return { verified: false, reason: `rpc error fetching head: ${e?.message ?? e}` };
  }
  const blockNumber = receipt.blockNumber;
  const confirmations = blockNumber != null ? head - blockNumber + 1 : 0;
  if (confirmations < minConfirmations) {
    return {
      verified: false,
      reason: `insufficient confirmations: ${confirmations} < ${minConfirmations}`,
      confirmations,
      blockNumber,
    };
  }

  // Scan logs for a USDC Transfer(_, escrow, value) emitted by the token.
  let observed = 0n;
  let sawWrongToken = false;
  let sawTransferToOther = false;
  for (const log of receipt.logs ?? []) {
    if (!log.topics || log.topics.length === 0) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    const isUsdc = eqAddr(log.address, tokenAddress);
    let parsed: ethers.LogDescription | null = null;
    try {
      parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    const to = parsed.args?.to as string;
    const value = parsed.args?.value as bigint;
    if (!isUsdc) {
      // A Transfer of some other token into the escrow does not count.
      if (eqAddr(to, escrowAddress)) sawWrongToken = true;
      continue;
    }
    if (eqAddr(to, escrowAddress)) {
      observed += value;
    } else {
      sawTransferToOther = true;
    }
  }

  if (observed === 0n) {
    if (sawWrongToken) {
      return { verified: false, reason: 'transfer to escrow was a different token, not USDC' };
    }
    if (sawTransferToOther) {
      return { verified: false, reason: 'USDC transfer did not land at the escrow address' };
    }
    return { verified: false, reason: 'no USDC transfer to escrow found in tx' };
  }

  if (observed < claimedAmount) {
    return {
      verified: false,
      reason: `transferred ${observed} < claimed ${claimedAmount}`,
      observedAmount: observed,
      confirmations,
      blockNumber,
    };
  }

  // Belt-and-suspenders: confirm balanceOf(escrow) rose by >= claimedAmount
  // across the deposit block. Guards against a spoofed Transfer log that did
  // not actually credit the escrow.
  try {
    const data = iface.encodeFunctionData('balanceOf', [escrowAddress]);
    const [balAfterRaw, balBeforeRaw] = await Promise.all([
      provider.call({ to: tokenAddress, data, blockTag: blockNumber }),
      provider.call({ to: tokenAddress, data, blockTag: blockNumber - 1 }),
    ]);
    const balAfter = BigInt(iface.decodeFunctionResult('balanceOf', balAfterRaw)[0]);
    const balBefore = BigInt(iface.decodeFunctionResult('balanceOf', balBeforeRaw)[0]);
    const delta = balAfter - balBefore;
    if (delta < claimedAmount) {
      return {
        verified: false,
        reason: `escrow balance delta ${delta} < claimed ${claimedAmount}`,
        observedAmount: observed,
        confirmations,
        blockNumber,
      };
    }
  } catch (e: any) {
    return { verified: false, reason: `balanceOf check failed: ${e?.message ?? e}` };
  }

  return { verified: true, observedAmount: observed, confirmations, blockNumber };
}
