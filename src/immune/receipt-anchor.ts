/**
 * immune/receipt-anchor.ts — stage the on-chain anchor for a combined trust receipt (Agent Immune System).
 *
 * Anchors a combined receipt's `content_hash` on Base Sepolia by REUSING the engine's existing EAS rail
 * (services/eas-attestation-service): the receipt maps onto the live `constitutional-compliance-v1` proof
 * schema with proofType='IMMUNE_COMBINED_RECEIPT' — no new schema, no new on-chain infra, it rides the funded
 * HYPERDAG attester. Pattern copied from memory/memory-root-anchor.ts: the chain write is INJECTED (default =
 * the real attestProof) so this is unit-testable offline, and it is INERT by default.
 *
 * THREE GATES, fail-closed, before anything can reach the chain:
 *   (1) the receipt must VERIFY and be AUTHORITATIVE. A receipt that does not verify under the given trust roots,
 *       or that is a self-signed DEMONSTRATION (authoritative:false — everything the #1495 slice emits today), is
 *       REFUSED. You never put a demo receipt's hash on Base Sepolia as if it were real. This is why the slice's
 *       own output cannot be anchored: the `authoritative` marker gates the on-chain path.
 *   (2) IMMUNE_ANCHOR_ENABLED must be set (default OFF ⇒ DRY-RUN): the prepared attestation is returned and the
 *       chain is never touched.
 *   (3) the attester key (HYPERDAG_ATTESTOR_PRIVATE_KEY) must be present — enforced by the EAS rail.
 *
 * The actual Base Sepolia send is a MAJOR/HITL action (the guard hook blocks on-chain sends; Sean runs it from the
 * engine env). This module only PREPARES the attestation and, only when explicitly enabled, delegates to attestProof.
 */
import { attestProof, type ProofAttestInput } from '../services/eas-attestation-service';
import { verifyCombinedReceipt, type SignedCombinedReceipt, type CombinedReceiptTrustRoots } from './combined-receipt';

/** The DOMAIN value under the shared proof schema that marks an attestation as a combined-receipt anchor. */
export const IMMUNE_RECEIPT_PROOF_TYPE = 'IMMUNE_COMBINED_RECEIPT';

/** The chain write, injectable so callers/tests supply a fake without a network round-trip (mirrors memory-root-anchor). */
export type AttestFn = (input: ProofAttestInput) => Promise<{ uid: string | null; txHash: string | null; error?: string }>;

export interface ReceiptAnchorResult {
  /** true ONLY when a real on-chain attestation was written. */
  anchored: boolean;
  /** true when the attestation was PREPARED but not sent (the default inert path). */
  dry_run: boolean;
  /** why it was not anchored, when refused (e.g. 'non_authoritative_receipt', 'receipt_unverified'). */
  refused?: string;
  /** the prepared attestation input — present whenever the receipt passed the gates, sent or not. */
  attest?: ProofAttestInput;
  /** the receipt content hash that would be / was anchored (0x + 64 hex, bytes32). */
  content_hash?: string;
  uid?: string | null;
  txHash?: string | null;
  error?: string;
}

/**
 * Map a combined receipt onto the existing EAS proof schema. PURE — no chain, no env. The receipt's keccak256
 * `content_hash` becomes the bytes32 `merkleRoot`; `proofType` is the domain; the maker id and headline result
 * are carried in the schema's agentId/tier fields. `epoch` is the uint64 proofId (default 0 for staging).
 */
export function buildReceiptAnchor(receipt: SignedCombinedReceipt, epoch = 0): ProofAttestInput {
  return {
    proofId: epoch,
    agentId: receipt.identities.maker_id,
    tier: receipt.result,
    merkleRoot: receipt.content_hash,
    proofType: IMMUNE_RECEIPT_PROOF_TYPE,
    repidSnapshot: 0,
  };
}

/**
 * Anchor one combined receipt — inert by default. Refuses a receipt that does not verify or is not authoritative;
 * otherwise prepares the attestation and, ONLY when `enabled` (default `IMMUNE_ANCHOR_ENABLED==='1'`), sends it via
 * `attestFn` (default the real attestProof). With `enabled` false it returns the prepared attestation, dry-run.
 */
export async function anchorReceipt(
  receipt: SignedCombinedReceipt,
  trustRoots: CombinedReceiptTrustRoots,
  opts: { attestFn?: AttestFn; enabled?: boolean; epoch?: number } = {},
): Promise<ReceiptAnchorResult> {
  const v = verifyCombinedReceipt(receipt, trustRoots);
  if (!v.ok) return { anchored: false, dry_run: false, refused: 'receipt_unverified', error: v.reasons.join(',') };
  if (!v.authoritative) return { anchored: false, dry_run: false, refused: 'non_authoritative_receipt' };

  const attest = buildReceiptAnchor(receipt, opts.epoch ?? 0);
  const content_hash = receipt.content_hash;
  const enabled = opts.enabled ?? process.env['IMMUNE_ANCHOR_ENABLED'] === '1';
  if (!enabled) return { anchored: false, dry_run: true, attest, content_hash };

  const attestFn = opts.attestFn ?? attestProof;
  const r = await attestFn(attest);
  if (r.error || !r.uid) {
    return { anchored: false, dry_run: false, attest, content_hash, uid: r.uid, txHash: r.txHash, error: r.error ?? 'attest returned no uid' };
  }
  return { anchored: true, dry_run: false, attest, content_hash, uid: r.uid, txHash: r.txHash };
}
