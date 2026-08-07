/**
 * x402-outcome-link.ts — STEP 2: bind an outcome to the money that moved.
 *
 * WHY THIS IS THE ANTI-GAMING PRIMITIVE. Self-reported success is free to
 * manufacture: an agent can claim a thousand successful jobs in a second. An
 * x402 settlement is not free — it is an on-chain transaction with a real
 * counterparty and a real cost. Requiring one for high-value positive deltas
 * means wash-trading reputation requires actually wash-trading money, which is
 * exactly the cost asymmetry that makes the attack unattractive.
 *
 * WHAT TRAVELS WITH THE OUTCOME. Only the settlement REFERENCE — a tx hash and
 * the chain it is on. Never an amount the agent asserts, never a signature the
 * agent produces. A relying party can independently resolve the hash on-chain
 * and see for itself; an agent-supplied amount would just be another unverified
 * claim wearing evidence's clothes.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not verify the transaction on-chain.
 * Resolving a hash is I/O and belongs in a service with a provider; doing it
 * here would make every delta computation a network call and make this module
 * untestable offline. It validates SHAPE and enforces POLICY, and says so —
 * `verified` is only ever true when a caller supplies an actual chain
 * observation.
 */
import { OutcomeClass, type OutcomeRecord } from './outcome-classification';

/** Base Sepolia, where the live x402 settlements and ERC-8004 registries are. */
export const DEFAULT_CHAIN_ID = 84532;

export interface PaymentProof {
  /** Settlement transaction hash. */
  txHash: string;
  chainId: number;
  /**
   * True ONLY when a caller has actually observed this tx on-chain. Defaults to
   * false: an unresolved hash is a claim, not evidence, and the two must never
   * be conflated.
   */
  verified: boolean;
  /** Set by whoever resolved it, so a stale observation is visible. */
  observedAt?: number | null;
}

export type ProofShapeError =
  | 'missing'
  | 'malformed_hash'
  | 'wrong_chain'
  | 'unverified';

/**
 * Validate the SHAPE of a payment proof. Deliberately strict: a 0x-prefixed
 * 32-byte hex hash, nothing else.
 *
 * Loose parsing here would let a placeholder like "pending" or "tx_123" satisfy
 * the anchor requirement, which would silently reopen the manufactured-success
 * hole this whole mechanism closes.
 */
export function validateProofShape(
  proof: PaymentProof | null | undefined,
  opts: { chainId?: number; requireVerified?: boolean } = {},
): { ok: true } | { ok: false; error: ProofShapeError; detail: string } {
  if (!proof || typeof proof.txHash !== 'string' || proof.txHash.length === 0) {
    return { ok: false, error: 'missing', detail: 'no payment proof attached' };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(proof.txHash)) {
    return {
      ok: false,
      error: 'malformed_hash',
      detail: 'txHash must be a 0x-prefixed 32-byte hex hash; a placeholder string is not a settlement',
    };
  }
  const expected = opts.chainId ?? DEFAULT_CHAIN_ID;
  if (proof.chainId !== expected) {
    return {
      ok: false,
      error: 'wrong_chain',
      detail: `settlement is on chain ${proof.chainId}, expected ${expected} — a payment on another chain does not anchor this outcome`,
    };
  }
  if (opts.requireVerified && proof.verified !== true) {
    return {
      ok: false,
      error: 'unverified',
      detail: 'payment proof has not been observed on-chain; an unresolved hash is a claim, not evidence',
    };
  }
  return { ok: true };
}

export interface LinkResult {
  /** The record with a shape-valid proof attached, or with it stripped. */
  record: OutcomeRecord;
  /** True when a proof survived validation and is attached. */
  anchored: boolean;
  /** Present when a supplied proof was rejected. */
  rejected?: { error: ProofShapeError; detail: string };
}

/**
 * Attach a payment proof to an outcome, or refuse to.
 *
 * A malformed proof is STRIPPED rather than passed through. Downstream,
 * `deltaFor` demotes an unanchored high-value success to UNCERTAIN — so a bad
 * proof produces the same conservative outcome as no proof, and never a
 * stronger one. Passing a malformed hash through would be worse than useless:
 * it would satisfy a truthy check while resolving to nothing on-chain.
 */
export function linkPaymentProof(
  record: OutcomeRecord,
  proof: PaymentProof | null | undefined,
  opts: { chainId?: number; requireVerified?: boolean } = {},
): LinkResult {
  const shape = validateProofShape(proof, opts);
  if (!shape.ok) {
    return {
      record: { ...record, x402PaymentProof: null },
      anchored: false,
      rejected: { error: shape.error, detail: shape.detail },
    };
  }
  return {
    record: { ...record, x402PaymentProof: proof!.txHash },
    anchored: true,
  };
}

/**
 * Does this outcome require an anchor to earn a strong positive?
 *
 * Mirrors `PAYMENT_PROOF_REQUIRED_ABOVE` so the policy lives in one place
 * conceptually even though it is checked in two: the caller can ask BEFORE
 * doing work whether an anchor will be needed, rather than discovering it after
 * the delta comes back zero.
 */
export function requiresPaymentAnchor(record: OutcomeRecord, threshold: number): boolean {
  const claimsSuccess =
    record.class === OutcomeClass.SUCCESS_AUDITED || record.class === OutcomeClass.SUCCESS_UNAUDITED;
  return claimsSuccess && record.valueAtRisk > threshold;
}
