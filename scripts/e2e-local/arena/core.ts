/**
 * L0 arena core: canonical JSON (RFC 8785), the experiment policy and its id, the Negotiated Payment
 * Agreement (EIP-712, signed by both parties with viem), and the settlement classifier.
 *
 * Spec: E:\dev\sprints\2026-10-20\AUTONOMY_LOOPS_SPEC.md §2 (policy), §3 (NPA), §4 (readback).
 * Pure functions only. No chain, no clock, no randomness, no environment.
 */
import { createHash } from 'node:crypto';
import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';

export type { Hex };
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Hex;

export const sha256Hex = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');

/**
 * RFC 8785 (JCS) canonical JSON of JSON data: keys sorted by UTF-16 code unit, no whitespace, strings
 * and numbers serialised as ECMAScript does (which is what RFC 8785 §3.2 specifies). bigint, NaN,
 * Infinity and functions throw: a policy or NPA that needs one has not been written in decimal strings.
 */
export function jcs(v: unknown): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new Error('jcs: non-finite number');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
      const o = v as Record<string, unknown>;
      return `{${Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`)
        .join(',')}}`;
    }
    default:
      throw new Error(`jcs: unsupported ${typeof v}`);
  }
}

// ── §2 experiment policy ─────────────────────────────────────────────────────────────────────────

export interface AssetEntry {
  symbol: string;
  /** 'native' or the ERC-20 contract. A new entry is only trusted after it is verified on its own chain. */
  contract: Hex | 'native';
  decimals: number;
}

export interface ArenaPolicyBody {
  level: 0;
  chain_id: number;
  assets: AssetEntry[];
  wallets: { buyer: Hex[]; seller: Hex[] };
  counterparties: Hex[];
  operations: string[];
  /** Raw integer amounts as decimal strings, keyed by asset symbol. */
  per_tx_max_raw: Record<string, string>;
  aggregate_max_raw: Record<string, string>;
  max_tx_count: number;
  max_fee_wei: string;
  /** Unix seconds. */
  not_before: number;
  expires_at: number;
  kill_switch_path: string;
  /** sha256 of the oracle file that grades this run (XC1 freezes it). */
  evaluator_sha256: string;
}

export interface ArenaPolicy extends ArenaPolicyBody {
  policy_id: string;
}

/** id = sha256 of the RFC 8785 bytes of the policy without its own id. */
export const policyIdOf = (body: ArenaPolicyBody): string => sha256Hex(jcs(body));

export function stampPolicy(body: ArenaPolicyBody): ArenaPolicy {
  return { policy_id: policyIdOf(body), ...body };
}

export function policyBodyOf(p: ArenaPolicy): ArenaPolicyBody {
  const { policy_id: _id, ...body } = p;
  return body;
}

export const assetKey = (a: Hex | 'native'): Hex => (a === 'native' ? ZERO_ADDRESS : (getAddress(a) as Hex));
export const sameAddr = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// ── §3 NPA (EIP-712) ─────────────────────────────────────────────────────────────────────────────

export interface Npa {
  buyer: Hex;
  seller: Hex;
  /** sha256 of the canonical work statement + acceptance criteria. */
  service_hash: Hex;
  chain_id: number;
  /** ERC-20 contract, or the zero address for the native asset. */
  asset: Hex;
  decimals: number;
  amount_raw: string;
  quote_source: string;
  /** Unix seconds. */
  quote_expires_at: number;
  max_fee_wei: string;
  settlement: 'onchain-readback';
  nonce: Hex;
}

export interface SignedNpa {
  npa: Npa;
  buyer_sig: Hex | null;
  seller_sig: Hex | null;
}

export const NPA_TYPES = {
  NegotiatedPaymentAgreement: [
    { name: 'buyer', type: 'address' },
    { name: 'seller', type: 'address' },
    { name: 'serviceHash', type: 'bytes32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'asset', type: 'address' },
    { name: 'decimals', type: 'uint8' },
    { name: 'amountRaw', type: 'uint256' },
    { name: 'quoteSource', type: 'string' },
    { name: 'quoteExpiresAt', type: 'uint64' },
    { name: 'maxFeeWei', type: 'uint256' },
    { name: 'settlement', type: 'string' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** The domain follows the NPA's own chain id, so an NPA signed for another chain verifies as that chain's. */
export const npaDomain = (n: Npa) => ({ name: 'HyperDAG Negotiated Payment Agreement', version: '1', chainId: BigInt(n.chain_id) }) as const;

export function npaMessage(n: Npa) {
  return {
    buyer: n.buyer,
    seller: n.seller,
    serviceHash: n.service_hash,
    chainId: BigInt(n.chain_id),
    asset: n.asset,
    decimals: n.decimals,
    amountRaw: BigInt(n.amount_raw),
    quoteSource: n.quote_source,
    quoteExpiresAt: BigInt(n.quote_expires_at),
    maxFeeWei: BigInt(n.max_fee_wei),
    settlement: n.settlement,
    nonce: n.nonce,
  };
}

/** The authorization identity (spec §4): sha256 of the canonical NPA. Two signatures do not enter it. */
export const npaHashOf = (n: Npa): string => sha256Hex(jcs(n));

export const serviceHashOf = (workStatement: string, criteria: string[]): Hex => `0x${sha256Hex(jcs({ work_statement: workStatement, acceptance_criteria: criteria }))}`;

export async function signNpa(account: PrivateKeyAccount, n: Npa): Promise<Hex> {
  return account.signTypedData({ domain: npaDomain(n), types: NPA_TYPES, primaryType: 'NegotiatedPaymentAgreement', message: npaMessage(n) });
}

/** The signer of one signature, or null when it is not a valid signature over exactly this NPA. */
export async function npaSigner(n: Npa, sig: Hex | null): Promise<string | null> {
  if (!sig) return null;
  try {
    return await recoverTypedDataAddress({ domain: npaDomain(n), types: NPA_TYPES, primaryType: 'NegotiatedPaymentAgreement', message: npaMessage(n), signature: sig });
  } catch {
    return null;
  }
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
