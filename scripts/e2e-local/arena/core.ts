/**
 * L0 arena core: re-exports of the pure spec §2-§4 pieces that now live in src/services/npa-preflight.ts (canonical
 * JSON, the experiment policy and its id, the NPA and its identity), plus the two things only a harness needs: signing
 * an NPA with viem, and classifying a settlement from a chain read-back.
 *
 * Spec: AUTONOMY_LOOPS_SPEC §2 (policy), §3 (NPA), §4 (readback). The exported names are unchanged so the callers
 * (world.ts, cases.ts, the adversarial lane's runner) do not move.
 */
import type { Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { NPA_TYPES, ZERO_ADDRESS, npaDomain, npaMessage, recoverNpaSigner, sameAddr, type Npa } from '../../../src/services/npa-preflight';

export type { Hex };
export {
  NPA_TYPES, ZERO_ADDRESS, assetKey, jcs, npaDomain, npaHashOf, npaMessage, policyBodyOf, policyIdOf, sameAddr, serviceHashOf, sha256Hex, stampPolicy,
} from '../../../src/services/npa-preflight';
export type {
  AssetEntry, ExperimentPolicy as ArenaPolicy, ExperimentPolicyBody as ArenaPolicyBody, Npa, SignedNpa,
} from '../../../src/services/npa-preflight';

export async function signNpa(account: PrivateKeyAccount, n: Npa): Promise<Hex> {
  return account.signTypedData({ domain: npaDomain(n), types: NPA_TYPES, primaryType: 'NegotiatedPaymentAgreement', message: npaMessage(n) } as never);
}

/** The signer of one signature, or null when it is not a valid signature over exactly this NPA. */
export async function npaSigner(n: Npa, sig: Hex | null): Promise<string | null> {
  return recoverNpaSigner(n, sig);
}

// ── §4 settlement classification ─────────────────────────────────────────────────────────────────

export interface TxReadback {
  found: boolean;
  success?: boolean;
  from?: Hex;
  to?: Hex | null;
  value?: bigint;
  block?: bigint;
  feeWei?: bigint;
  /** Set when the node could not be asked (distinct from a clean not-found). */
  error?: string;
  /** ERC-20 Transfer logs in the receipt. */
  transfers: Array<{ token: Hex; from: Hex; to: Hex; amount: bigint }>;
}

export type SettlementStatus = 'SETTLED' | 'FAILED' | 'UNKNOWN';

/**
 * What the chain says about an NPA's payment. Only an exact match is SETTLED. A transaction that is
 * not found, or that the node could not be asked about, is UNKNOWN; one that is found and reverted,
 * or that paid something other than the agreed asset, amount and recipient from the agreed payer, is
 * FAILED. A failed or uncertain readback is never SETTLED (spec §4).
 */
export function classifySettlement(n: Npa, rb: TxReadback | null): { status: SettlementStatus; why: string } {
  if (!rb || !rb.found) return { status: 'UNKNOWN', why: rb?.error ? `the node could not answer: ${rb.error}` : 'the transaction was not found on this chain' };
  if (rb.success === undefined) return { status: 'UNKNOWN', why: 'the transaction has no receipt yet' };
  if (!rb.success) return { status: 'FAILED', why: 'the transaction reverted' };
  const amount = BigInt(n.amount_raw);
  if (!rb.from || !sameAddr(rb.from, n.buyer)) return { status: 'FAILED', why: 'the transaction was not sent by the NPA buyer' };
  if (sameAddr(n.asset, ZERO_ADDRESS)) {
    if (!rb.to || !sameAddr(rb.to, n.seller)) return { status: 'FAILED', why: 'native value went to a different recipient' };
    if (rb.value !== amount) return { status: 'FAILED', why: `native value ${rb.value} is not the agreed ${amount}` };
    return { status: 'SETTLED', why: 'native value, recipient and payer match the NPA' };
  }
  if (!rb.to || !sameAddr(rb.to, n.asset)) return { status: 'FAILED', why: 'the transaction did not call the agreed token contract' };
  if ((rb.value ?? 0n) !== 0n) return { status: 'FAILED', why: 'native value moved in a token payment' };
  const hits = rb.transfers.filter((t) => sameAddr(t.token, n.asset) && sameAddr(t.from, n.buyer) && sameAddr(t.to, n.seller) && t.amount === amount);
  if (hits.length !== 1 || rb.transfers.length !== 1) return { status: 'FAILED', why: 'the Transfer log is not exactly the agreed payment' };
  return { status: 'SETTLED', why: 'exactly one Transfer log of the agreed token, payer, recipient and amount' };
}
