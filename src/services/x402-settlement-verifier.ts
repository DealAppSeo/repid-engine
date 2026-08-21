/**
 * x402-settlement-verifier.ts — turn a claimed settlement into an observed one.
 *
 * WHAT WAS MISSING. `x402-outcome-link.ts` validates the SHAPE of a payment
 * proof and says so plainly: *"It does not verify the transaction on-chain.
 * Resolving a hash is I/O and belongs in a service with a provider."*
 * `settlement-reconciler.ts` defers to the same absent service: *"reconciling
 * means asserting an on-chain fact, so it requires a verified receipt from the
 * chain — never a guess from proximity in time."*
 *
 * **That service did not exist.** So `PaymentProof.verified` was set by whoever
 * built the proof, and nothing ever contradicted them. The no-proof-no-pay
 * anchor — the mechanism that makes wash-trading reputation cost real money —
 * was checking that a hash was *well-formed*, not that it was *real*. A
 * 32-byte hex string that resolves to nothing passes shape validation.
 *
 * THE SECOND CLAIM THIS CLOSES, WHICH IS EASY TO MISS. The caller also asserts
 * the service value, and that number does more than scale the delta: value at
 * risk picks the RISK BAND, so an unverified value chooses its own level of
 * scrutiny. Requiring `observed >= claimed` makes "claim a large service value,
 * pay a small amount" fail, rather than buying both an inflated delta and a
 * self-selected band.
 *
 * WHY THIS IS NOT `deposit-verifier.ts` WITH THE ADDRESS SWAPPED. That module
 * verifies a deposit into a single, fixed escrow, and finishes with a
 * belt-and-suspenders check that `balanceOf(escrow)` rose by at least the
 * claimed amount across the block.
 *
 * **That check is sound for an escrow and unsound here.** An escrow's balance
 * moves for one reason. An agent's wallet is an ordinary account that can also
 * SPEND in the same block, so its balance delta can be smaller than the amount
 * it genuinely received — and the check would report `verified: false` for a
 * real payment. A false negative here demotes an honest agent's success to
 * UNCERTAIN, which is a punishment for someone else's block-ordering.
 *
 * It is dropped rather than copied, and the safety it provided is preserved by
 * the check that was doing the real work anyway: the log must be emitted BY the
 * canonical token contract (`eqAddr(log.address, tokenAddress)`). A `Transfer`
 * topic from any other address is not a USDC transfer, whatever it claims, so
 * a spoofed log never counts in the first place.
 *
 * FOUR STATES, NOT TWO. `verified: false` is returned both for *"we looked and
 * the money is not there"* and for *"we could not look"*. Those demote a claim
 * identically — which is correct, unverified value must not earn — but they are
 * NOT the same fact, and `evidence` keeps them apart. Reporting an RPC outage as
 * a failed verification is how an infrastructure problem becomes an accusation.
 */
import { ethers } from 'ethers';
import { config } from '../config';
import type { EthProviderLike } from './deposit-verifier';
import type { PaymentProof } from './x402-outcome-link';
import { DEFAULT_CHAIN_ID } from './x402-outcome-link';

const ERC20_ABI = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const iface = new ethers.Interface(ERC20_ABI);

/** USDC has 6 decimals. A whole-dollar figure times this is the smallest unit. */
export const USDC_DECIMALS = 6;

/**
 * Its own provider seam, deliberately not shared with `deposit-verifier`.
 *
 * Reusing that module's factory would entangle two unrelated test seams: a test
 * swapping a provider for a deposit case would silently swap it for settlement
 * verification too. The `EthProviderLike` CONTRACT is reused — that is the part
 * worth sharing — while the mutable state is not.
 */
let providerFactory: () => EthProviderLike = () =>
  new ethers.JsonRpcProvider(config.baseSepoliaRpc) as unknown as EthProviderLike;

/** Test seam: swap in a mock provider factory. Call with undefined to reset. */
export function __setSettlementProviderFactory(f?: () => EthProviderLike): void {
  providerFactory = f
    ? f
    : () => new ethers.JsonRpcProvider(config.baseSepoliaRpc) as unknown as EthProviderLike;
}

export interface VerifySettlementInput {
  txHash: string;
  /** Address that must have RECEIVED the payment — the provider agent's wallet. */
  payeeAddress: string;
  /** Service value the caller claims, in whole USDC. Verified as a lower bound. */
  claimedValueUsdc: number;
  /** Canonical token. Defaults to the configured USDC address. */
  tokenAddress?: string | null;
  minConfirmations?: number;
  /** Chain the settlement must be on. */
  chainId?: number;
}

export type SettlementEvidence = 'MEASURED' | 'NOT_CHECKED';

export interface VerifySettlementResult {
  /** True ONLY when a transfer of at least the claimed value to the payee was observed. */
  verified: boolean;
  /**
   * Whether the chain was actually consulted. `NOT_CHECKED` means the answer is
   * an absence, not a finding — never report it as a failed verification.
   */
  evidence: SettlementEvidence;
  reason: string;
  observedAmount?: bigint;
  confirmations?: number;
  blockNumber?: number;
}

function eqAddr(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  try {
    return ethers.getAddress(a) === ethers.getAddress(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/** Whole USDC → smallest unit, rounded UP so a claim is never verified against less than it asserted. */
export function usdcToSmallestUnit(valueUsdc: number): bigint {
  if (!Number.isFinite(valueUsdc) || valueUsdc <= 0) return 0n;
  return BigInt(Math.ceil(valueUsdc * 10 ** USDC_DECIMALS));
}

/**
 * Resolve a claimed settlement against the chain.
 *
 * Never throws for an expected rejection; an RPC problem comes back as
 * `NOT_CHECKED` rather than as a verdict.
 */
export async function verifySettlement(
  input: VerifySettlementInput,
): Promise<VerifySettlementResult> {
  const tokenAddress = input.tokenAddress ?? config.usdcTokenAddress;
  const minConfirmations = input.minConfirmations ?? config.stakeMinConfirmations ?? 1;
  const chainId = input.chainId ?? DEFAULT_CHAIN_ID;

  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash ?? '')) {
    // A shape failure is a finding, not an absence — we did look, at the input.
    return { verified: false, evidence: 'MEASURED', reason: 'tx hash is not a 32-byte hex hash' };
  }
  if (!input.payeeAddress) {
    return { verified: false, evidence: 'NOT_CHECKED', reason: 'no payee address to verify against' };
  }
  if (!tokenAddress) {
    return { verified: false, evidence: 'NOT_CHECKED', reason: 'token address not configured' };
  }
  if (chainId !== DEFAULT_CHAIN_ID) {
    return {
      verified: false,
      evidence: 'NOT_CHECKED',
      reason: `no provider configured for chain ${chainId}; this verifier reads chain ${DEFAULT_CHAIN_ID}`,
    };
  }

  const claimed = usdcToSmallestUnit(input.claimedValueUsdc);
  const provider = providerFactory();

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await provider.getTransactionReceipt(input.txHash);
  } catch (e: any) {
    return { verified: false, evidence: 'NOT_CHECKED', reason: `rpc error fetching receipt: ${e?.message ?? e}` };
  }
  if (!receipt) {
    // An unmined or unknown tx IS an observation: we asked and the chain has no
    // such settlement. That is a finding.
    return { verified: false, evidence: 'MEASURED', reason: 'tx not found on chain (unmined or unknown)' };
  }
  if ((receipt as any).status === 0) {
    return { verified: false, evidence: 'MEASURED', reason: 'tx reverted — no value moved' };
  }

  let head: number;
  try {
    head = await provider.getBlockNumber();
  } catch (e: any) {
    return { verified: false, evidence: 'NOT_CHECKED', reason: `rpc error fetching head: ${e?.message ?? e}` };
  }

  const blockNumber = receipt.blockNumber;
  const confirmations = blockNumber != null ? head - blockNumber + 1 : 0;
  if (confirmations < minConfirmations) {
    return {
      verified: false,
      evidence: 'MEASURED',
      reason: `insufficient confirmations: ${confirmations} < ${minConfirmations}`,
      confirmations,
      blockNumber,
    };
  }

  let observed = 0n;
  let sawWrongToken = false;
  let sawTransferElsewhere = false;

  for (const log of receipt.logs ?? []) {
    if (!log.topics || log.topics.length === 0) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;

    // The emitter check is the load-bearing one: a Transfer topic from any
    // address other than the canonical token is not a USDC transfer, whatever
    // its arguments say.
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
      if (eqAddr(to, input.payeeAddress)) sawWrongToken = true;
      continue;
    }
    if (eqAddr(to, input.payeeAddress)) observed += value;
    else sawTransferElsewhere = true;
  }

  if (observed === 0n) {
    if (sawWrongToken) {
      return {
        verified: false,
        evidence: 'MEASURED',
        reason: 'the transfer to the payee was a different token, not USDC',
        confirmations,
        blockNumber,
      };
    }
    if (sawTransferElsewhere) {
      return {
        verified: false,
        evidence: 'MEASURED',
        reason: 'a USDC transfer occurred but did not land at the payee address',
        confirmations,
        blockNumber,
      };
    }
    return {
      verified: false,
      evidence: 'MEASURED',
      reason: 'no USDC transfer to the payee found in this tx',
      confirmations,
      blockNumber,
    };
  }

  if (claimed > 0n && observed < claimed) {
    // The claim is not merely unproven, it is CONTRADICTED. Value at risk picks
    // the risk band as well as scaling the delta, so an inflated claim would buy
    // both a larger movement and a self-selected level of scrutiny.
    return {
      verified: false,
      evidence: 'MEASURED',
      reason: `settlement moved ${observed} but the claimed service value is ${claimed} (smallest unit)`,
      observedAmount: observed,
      confirmations,
      blockNumber,
    };
  }

  return {
    verified: true,
    evidence: 'MEASURED',
    reason: `observed ${observed} USDC (smallest unit) to the payee at ${confirmations} confirmations`,
    observedAmount: observed,
    confirmations,
    blockNumber,
  };
}

/**
 * Resolve a claimed `PaymentProof` into one whose `verified` flag is an
 * OBSERVATION rather than an assertion.
 *
 * The incoming `verified` is discarded, not trusted. That is the whole point:
 * a caller-supplied `true` is exactly the claim this service exists to check,
 * and carrying it forward on an RPC failure would let an outage grant the
 * anchor that the chain never did.
 */
export async function resolvePaymentProof(
  claimed: PaymentProof,
  opts: {
    payeeAddress: string;
    claimedValueUsdc: number;
    minConfirmations?: number;
    /** Canonical token. Defaults to the configured USDC address, as in production. */
    tokenAddress?: string | null;
  },
): Promise<{ proof: PaymentProof; result: VerifySettlementResult }> {
  const result = await verifySettlement({
    txHash: claimed.txHash,
    payeeAddress: opts.payeeAddress,
    claimedValueUsdc: opts.claimedValueUsdc,
    chainId: claimed.chainId,
    ...(opts.tokenAddress !== undefined ? { tokenAddress: opts.tokenAddress } : {}),
    ...(opts.minConfirmations !== undefined ? { minConfirmations: opts.minConfirmations } : {}),
  });

  return {
    proof: {
      txHash: claimed.txHash,
      chainId: claimed.chainId,
      verified: result.verified,
      // Stamped only on a real observation, so a stale or absent reading is
      // visible rather than inferred from a missing field.
      observedAt: result.evidence === 'MEASURED' ? Date.now() : null,
    },
    result,
  };
}
