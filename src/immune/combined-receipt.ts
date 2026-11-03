/**
 * immune/combined-receipt.ts — the COMBINED TRUST RECEIPT for the Agent Immune System slice.
 *
 * WHY. Four proofs already exist for a single agent task — the sandbox vetted the artifact, an
 * evaluator judged it correct, the policy kernel let it run, the reputation engine settled a score —
 * but they live in four shapes. A forger's easiest move is RECOMBINATION: take the sandbox proof for
 * task A, the "correct" evaluation of task B, and a settlement from task C, and present the three as
 * one success. This receipt binds them: every proof names the SAME artifact_hash / evaluation_version
 * / policy_digest / execution_sha / experiment_id, and an independent verifier REFUSES the moment the
 * bindings disagree or a dishonest combination is claimed (e.g. "settled" on an "incorrect" result,
 * or "independent" when maker and checker share a controller).
 *
 * FIVE DISTINCT STATUS FACTS, never collapsed into one "VERIFIED": executed (it ran), contained (which
 * protections held), verified_correct (a SEPARATE evaluator's verdict), settled (a score moved), and
 * independence_class (was the checker a different controller). The headline is `result`
 * (correct | incorrect | not_scorable), not a bare boolean — because "it ran and was contained" is not
 * "it was correct", and neither is "it settled".
 *
 * SIGNING KEY IS A PARAMETER (never read from env here). This module sits on the untrusted path: it
 * must not be able to reach a secret. signCombinedReceipt takes the Ed25519 private key from its
 * caller and reuses the kernel's signing approach (domain tag + canonical JSON over the body minus its
 * hash and signature). verifyCombinedReceipt is INDEPENDENT: given only the receipt and a trusted-signer
 * list (and optionally the experiment_ids already seen), it re-derives every binding and refuses on any
 * mismatch. It never throws and never mutates.
 */
import { keccak256, toUtf8Bytes } from 'ethers';
import { KERNEL_RECEIPT_SIGNATURE_DOMAIN, signerFromPublicKey, verifyEd25519 } from '../kernel/receipt-signing';
import type { ReceiptSigner } from '../kernel/types';
import { canonicalJson } from '../services/owner-authorization';
import type { Eligibility } from '../services/experimental-repid';
import { createPublicKey, sign, type KeyObject } from 'node:crypto';

export const COMBINED_RECEIPT_SCHEMA = 'immune-combined-receipt/1' as const;

/**
 * The bytes a combined-receipt signature signs are prefixed with THIS, built from the kernel's own
 * domain tag plus a combined-receipt discriminator line. Reusing the kernel constant keeps the lineage;
 * the extra line guarantees a kernel-receipt signature can never be replayed as a combined-receipt one
 * (its signed bytes continue with a kernel receipt's canonical JSON, never this discriminator).
 */
export const COMBINED_RECEIPT_SIGNATURE_DOMAIN = `${KERNEL_RECEIPT_SIGNATURE_DOMAIN}hyperdag.immune.combined-receipt.v1\n`;

/** Reuses experimental-repid's eligibility axis: 'independent_counterparty' is only honest when the checker's controller differs from the maker's. */
export type IndependenceClass = Eligibility;

/** The SEPARATE evaluator's verdict. 'missing_evaluation' means no evaluator answered — which must never read as a settled success. */
export type VerifiedCorrect = 'correct' | 'incorrect' | 'missing_evaluation';

/** The headline, derived from all five facts. NOT a bare "VERIFIED". */
export type ReceiptResult = 'correct' | 'incorrect' | 'not_scorable';

/** One container-profile check the sandbox ran (e.g. seccomp, no-network, read-only-fs). */
export interface SandboxProfileCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

/**
 * The provenance this receipt needs FROM the TrustShell sandbox receipt (which lives in another repo
 * and is never imported). A typed input, not a cross-repo dependency: schema + mission, the artifact's
 * sha256, the container profile checks, and the airlock's promote/refuse decision.
 */
export interface SandboxReceiptProvenance {
  schema_id: string;
  mission_id: string;
  /** sha256 of the artifact/candidate the sandbox vetted. Must equal the receipt's bound artifact_hash. */
  artifact_sha256: string;
  profile_checks: SandboxProfileCheck[];
  airlock_decision: 'promote' | 'refuse';
}

export interface CombinedReceiptIdentities {
  maker_id: string;
  /** The controller (owner/operator) behind the maker. Independence is about controllers, not ids. */
  maker_controller: string;
  checker_id: string;
  checker_controller: string;
  challenger_id?: string;
}

/** The answer-key set a correctness claim was ruled against — a measurement with no ruler is not a result. */
export interface Ruler {
  answer_key_set_id: string;
  hash: string;
}

/** Everything in a combined receipt except its content hash and signature. */
export interface CombinedReceiptBody {
  schema: typeof COMBINED_RECEIPT_SCHEMA;
  // ── BOUND fields: every proof must name the same values, or the pieces came from different tasks ──
  artifact_hash: string;
  evaluation_version: string;
  policy_digest: string;
  execution_sha: string;
  experiment_id: string;
  ruler: Ruler;
  mode: 'shadow' | 'active';
  identities: CombinedReceiptIdentities;
  // ── the FIVE distinct status facts ──
  executed: boolean;
  /** Which protections held during execution (e.g. 'seccomp', 'network_egress_blocked'). */
  contained: string[];
  verified_correct: VerifiedCorrect;
  settled: boolean;
  settlement_event_id: string | null;
  independence_class: IndependenceClass;
  // ── provenance carried from the sandbox receipt (other repo) ──
  sandbox: SandboxReceiptProvenance;
  // ── the headline ──
  result: ReceiptResult;
}

export interface CombinedReceipt extends CombinedReceiptBody {
  /** keccak256 of the canonical JSON of the body. Binds every field: swap one and this stops matching. */
  content_hash: string;
}

export interface SignedCombinedReceipt extends CombinedReceipt {
  signer: ReceiptSigner;
  /** Ed25519 over COMBINED_RECEIPT_SIGNATURE_DOMAIN + canonical JSON of the receipt minus signer/signature, 0x + 128 hex. */
  signature: string;
}

export type CombinedReceiptInput = Omit<CombinedReceiptBody, 'schema'>;

/** Strip the hash and signature fields so build and verify hash exactly the same bytes. */
function bodyForContentHash(r: Record<string, unknown>): Record<string, unknown> {
  const { content_hash: _c, signer: _g, signature: _s, ...body } = r;
  return body;
}

/** keccak256 of the canonical JSON of the receipt body (no content_hash, no signature). */
export function combinedReceiptContentHash(r: CombinedReceiptBody | CombinedReceipt | SignedCombinedReceipt): string {
  return keccak256(toUtf8Bytes(canonicalJson(bodyForContentHash(r as unknown as Record<string, unknown>))));
}

/** The bytes a signature signs: domain tag + canonical JSON of the receipt minus signer/signature (content_hash included). */
export function combinedReceiptSigningMessage(r: CombinedReceipt | SignedCombinedReceipt): string {
  const { signer: _g, signature: _s, ...rest } = r as unknown as Record<string, unknown>;
  return COMBINED_RECEIPT_SIGNATURE_DOMAIN + canonicalJson(rest);
}

/** Assemble a combined receipt and seal its content hash. Does not sign; signing takes a key the caller holds. */
export function buildCombinedReceipt(input: CombinedReceiptInput): CombinedReceipt {
  const body: CombinedReceiptBody = { schema: COMBINED_RECEIPT_SCHEMA, ...input };
  return { ...body, content_hash: combinedReceiptContentHash(body) };
}

/** The raw 32-byte Ed25519 public key (0x + 64 hex) derived from a private key. */
function publicKeyHexFromPrivate(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  return `0x${Buffer.from(String(jwk.x), 'base64url').toString('hex')}`;
}

/**
 * Sign a built receipt with an Ed25519 private key the CALLER supplies (never an env secret). Reuses the
 * kernel's domain-tag approach. Throws only if `signingKey` is not an Ed25519 private key.
 */
export function signCombinedReceipt(r: CombinedReceipt, signingKey: KeyObject): SignedCombinedReceipt {
  const signer = signerFromPublicKey(publicKeyHexFromPrivate(signingKey));
  if (signer === null) throw new Error('[immune] signCombinedReceipt: signingKey is not an Ed25519 private key');
  const unsigned = { ...r, signer, signature: '' } as SignedCombinedReceipt;
  const signature = `0x${sign(null, Buffer.from(combinedReceiptSigningMessage(unsigned), 'utf8'), signingKey).toString('hex')}`;
  return { ...r, signer, signature };
}

export interface CombinedReceiptVerification {
  ok: boolean;
  reasons: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const eqHex = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * An INDEPENDENT verifier. ok=true only when every binding holds and no dishonest combination is claimed.
 * Never throws, never mutates. `seenExperimentIds` is how a replay is caught: the caller passes the ids it
 * has already honoured; this function reports a hit, the caller records the id after a clean verify.
 *
 * REFUSES (ok=false) when:
 *  (1) the signature is missing/invalid or the signer is not trusted;
 *  (2) result is 'incorrect' or 'not_scorable' yet settled===true — an incorrect/unscored deliverable must not read as a settled success;
 *  (3) independence_class is 'independent_counterparty' yet maker and checker share a controller;
 *  (4) artifact_hash ≠ the sandbox's artifact_sha256, or any bound field was swapped (content_hash no longer matches);
 *  (5) verified_correct is missing yet settled===true (a score moved on an un-evaluated deliverable);
 *  (6) experiment_id has already been seen (replay).
 */
export function verifyCombinedReceipt(
  receipt: unknown,
  trustedSigners: readonly { fingerprint: string }[],
  seenExperimentIds: ReadonlySet<string> = new Set(),
): CombinedReceiptVerification {
  const reasons: string[] = [];
  const refuse = (reason: string): void => {
    reasons.push(reason);
  };

  if (!isObj(receipt) || !isObj(receipt['identities']) || !isObj(receipt['sandbox'])) {
    return { ok: false, reasons: ['malformed'] };
  }
  const r = receipt as unknown as SignedCombinedReceipt;

  // (1) signature present, verifies under its named key, and that key is trusted.
  const signer = (r as { signer?: ReceiptSigner }).signer;
  const signature = (r as { signature?: string }).signature;
  if (!isObj(signer) || typeof signature !== 'string') {
    refuse('unsigned');
  } else if (signerFromPublicKey(signer.public_key)?.fingerprint !== signer.fingerprint.toLowerCase()) {
    refuse('signer_fingerprint_mismatch');
  } else if (!verifyEd25519(signer.public_key, combinedReceiptSigningMessage(r), signature)) {
    refuse('signature_invalid');
  } else if (!trustedSigners.some((t) => t.fingerprint.toLowerCase() === signer.fingerprint.toLowerCase())) {
    refuse('untrusted_signer');
  }

  // (4) recombination: artifact_hash must equal the sandbox's candidate sha256, and no bound field may have moved.
  if (!eqHex(r.artifact_hash, r.sandbox.artifact_sha256)) refuse('artifact_hash_unbound');
  if (r.content_hash !== combinedReceiptContentHash(r)) refuse('content_hash_mismatch');

  // (2) an incorrect/unscored deliverable must not read as a settled success.
  if ((r.result === 'incorrect' || r.result === 'not_scorable') && r.settled === true) refuse('incorrect_but_settled');

  // (3) never claim independence when maker and checker share a controller.
  if (r.independence_class === 'independent_counterparty' && r.identities.maker_controller === r.identities.checker_controller) {
    refuse('false_independence');
  }

  // (5) a score cannot settle on an un-evaluated deliverable.
  if ((r.verified_correct == null || r.verified_correct === 'missing_evaluation') && r.settled === true) refuse('settled_without_evaluation');

  // (6) replay.
  if (seenExperimentIds.has(r.experiment_id)) refuse('experiment_replayed');

  return { ok: reasons.length === 0, reasons };
}
