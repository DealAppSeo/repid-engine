/**
 * immune/combined-receipt.ts — the COMBINED TRUST RECEIPT for the Agent Immune System slice.
 *
 * WHY. Four proofs already exist for a single agent task — the sandbox vetted the artifact, an
 * evaluator judged it correct, the policy kernel let it run, the reputation engine settled a score —
 * but they live in four shapes. A forger's easiest move is RECOMBINATION: take the sandbox proof for
 * task A, the "correct" evaluation of task B, and a settlement from task C, and present the three as
 * one success. This receipt binds them: every proof names the SAME artifact_hash / evaluation_version
 * / policy_digest / execution_sha / experiment_id, and an independent verifier REFUSES the moment the
 * bindings disagree or a dishonest combination is claimed.
 *
 * ISSUE A — GROUND THE COMPONENTS, DON'T TRUST THE COMPOSITE SIGNER. A composite signature over a
 * consistent body only proves the composite SIGNER vouched for that body; a trusted-but-careless (or
 * compromised) signer could seal a FABRICATED-but-consistent combination. So the receipt EMBEDS the
 * three underlying attestations — sandbox, evaluation, settlement — each signed by its OWN authority
 * under its OWN domain tag, and the verifier re-checks every one against its OWN trust root and
 * cross-matches the identifiers. The composite can no longer invent a component; it can only carry
 * ones that each real authority already signed.
 *
 * WHAT THE PURE VERIFIER PROVES, AND WHAT IT DOES NOT. verifyCombinedReceipt proves the three
 * attestations are AUTHENTIC (each signed by a key trusted for that role) and CONSISTENT (every bound
 * identifier agrees, no dishonest combination is claimed). It deliberately does NOT prove that the
 * settlement row actually exists in the database, or that the maker and checker controllers are truly
 * distinct entries in repid_agents — that GROUNDING against live state is the trusted settlement
 * component's job (Job B). This is a layering choice: authenticity + internal consistency here,
 * existence + real-world distinctness one layer down.
 *
 * FIVE DISTINCT STATUS FACTS, never collapsed into one "VERIFIED": executed (it ran), contained (which
 * protections held), verified_correct (a SEPARATE evaluator's verdict, carried in the signed evaluation
 * attestation), settled (a score moved), and independence_class (was the checker a different
 * controller). The headline is `result` (correct | incorrect | not_scorable), not a bare boolean.
 *
 * NEGATIVE SETTLEMENT IS LEGITIMATE. An independently-verified INCORRECT result MUST be eligible to
 * settle a negative-reputation delta (the lose-autonomy mechanic). What is forbidden is representing it
 * as a SUCCESS. So `settlement_outcome` (success | failure | none) is set by the trusted settler from
 * the actual delta sign, and the verifier refuses only the dishonest pairings (incorrect→success,
 * correct→failure, settled↔none disagreement) — never a correctly-signed failure.
 *
 * SIGNING KEYS ARE PARAMETERS (never read from env here). This module sits on the untrusted path: it
 * must not be able to reach a secret. Every sign* function takes the Ed25519 private key from its caller
 * and reuses the kernel's signing approach (domain tag + canonical JSON). verifyCombinedReceipt is
 * INDEPENDENT: given only the receipt, a set of trust roots, and optionally the experiment_ids already
 * seen, it re-derives every binding and refuses on any mismatch. It never throws and never mutates.
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

/** Each component attestation signs under its OWN domain, so one authority's signature can never pass as another's. */
export const SANDBOX_ATTESTATION_DOMAIN = `${KERNEL_RECEIPT_SIGNATURE_DOMAIN}hyperdag.immune.sandbox-attestation.v1\n`;
export const EVALUATION_ATTESTATION_DOMAIN = `${KERNEL_RECEIPT_SIGNATURE_DOMAIN}hyperdag.immune.evaluation-attestation.v1\n`;
export const SETTLEMENT_ATTESTATION_DOMAIN = `${KERNEL_RECEIPT_SIGNATURE_DOMAIN}hyperdag.immune.settlement-attestation.v1\n`;

/** Reuses experimental-repid's eligibility axis: 'independent_counterparty' is only honest when the checker's controller differs from the maker's. */
export type IndependenceClass = Eligibility;

/** The SEPARATE evaluator's verdict. 'missing_evaluation' means no evaluator answered — which must never read as a settled success. */
export type VerifiedCorrect = 'correct' | 'incorrect' | 'missing_evaluation';

/** The headline, derived from all five facts. NOT a bare "VERIFIED". */
export type ReceiptResult = 'correct' | 'incorrect' | 'not_scorable';

/**
 * What the settler actually did, from the sign of the reputation delta. 'none' when nothing settled.
 * A 'failure' is a legitimate NEGATIVE settlement of a verified-incorrect result — not an error.
 */
export type SettlementOutcome = 'success' | 'failure' | 'none';

/** One container-profile check the sandbox ran (e.g. seccomp, no-network, read-only-fs). */
export interface SandboxProfileCheck {
  name: string;
  passed: boolean;
  detail?: string;
}

/** A component proof signed by its OWN authority, embedded in the receipt. `signer`/`signature` cover `payload` under the component's domain. */
export interface ComponentAttestation<P> {
  payload: P;
  signer: ReceiptSigner;
  /** Ed25519 over `<component domain> + canonicalJson(payload)`, 0x + 128 hex. */
  signature: string;
}

/** What the HARNESS signs: the sandbox provenance that the TrustShell sandbox receipt (another repo) established. */
export interface SandboxAttestationPayload {
  mission_id: string;
  /** sha256 of the artifact the sandbox vetted. Must equal the receipt's bound artifact_hash. */
  artifact_sha256: string;
  profile_checks: SandboxProfileCheck[];
  airlock_decision: 'promote' | 'refuse';
}

/**
 * What the EVALUATOR signs. The checker identity AND controller come from THIS signed payload, not a
 * bare composite field — closing the "caller-supplied strings" gap that let a receipt claim
 * independence it had not earned.
 */
export interface EvaluationAttestationPayload {
  verified_correct: VerifiedCorrect;
  evaluation_version: string;
  checker_id: string;
  checker_controller: string;
  /** The oracle/claim the correctness verdict was ruled against — a measurement with no ruler is not a result. */
  oracle_set_id: string;
}

/** What the SETTLEMENT/engine signs: the settlement event, its outcome, and the task/parties it belongs to. */
export interface SettlementAttestationPayload {
  settlement_event_id: string;
  settlement_outcome: SettlementOutcome;
  experiment_id: string;
  maker_id: string;
  checker_id: string;
}

export interface CombinedReceiptIdentities {
  maker_id: string;
  /** The controller (owner/operator) behind the maker. Independence is about controllers, not ids. */
  maker_controller: string;
  checker_id: string;
  challenger_id?: string;
}

/** The oracle set a correctness claim was ruled against — a measurement with no ruler is not a result. */
export interface Ruler {
  oracle_set_id: string;
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
  // ── the status facts (verified_correct now lives in the signed evaluation attestation) ──
  executed: boolean;
  /** Which protections held during execution (e.g. 'seccomp', 'network_egress_blocked'). */
  contained: string[];
  settled: boolean;
  settlement_event_id: string | null;
  /** The sign of the settled delta, per the settler. A verified-incorrect result may legitimately settle 'failure'. */
  settlement_outcome: SettlementOutcome;
  independence_class: IndependenceClass;
  // ── the three embedded, independently-signed component attestations (Issue A grounding) ──
  sandbox_attestation: ComponentAttestation<SandboxAttestationPayload>;
  evaluation_attestation: ComponentAttestation<EvaluationAttestationPayload>;
  settlement_attestation: ComponentAttestation<SettlementAttestationPayload>;
  // ── the headline ──
  result: ReceiptResult;
  /**
   * Whether this receipt is backed by a PINNED authority. Absent or false ⇒ a self-signed demonstration
   * (throwaway per-run keys, no pinned harness/oracle/settlement authority) — NOT a trust anchor. It is
   * bound by content_hash + signature, and verifyCombinedReceipt surfaces it, so a green verify of a demo
   * receipt is never mistaken for authority. A real pinned-authority binding is the next Sean-gated gate.
   */
  authoritative?: boolean;
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

/** The trust roots a verifier pins, one set per signing role. A key trusted for one role is never trusted for another. */
export interface CombinedReceiptTrustRoots {
  combined: readonly { fingerprint: string }[];
  sandbox: readonly { fingerprint: string }[];
  evaluation: readonly { fingerprint: string }[];
  settlement: readonly { fingerprint: string }[];
}

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

/** The bytes a component attestation signs: its own domain tag + canonical JSON of the payload. */
function attestationSigningMessage(domain: string, payload: unknown): string {
  return domain + canonicalJson(payload);
}

/**
 * Sign one component payload under its own domain with the authority's Ed25519 key (never an env secret).
 * Throws only if `signingKey` is not an Ed25519 private key. Pass SANDBOX_/EVALUATION_/SETTLEMENT_ATTESTATION_DOMAIN.
 */
export function signComponentAttestation<P>(domain: string, payload: P, signingKey: KeyObject): ComponentAttestation<P> {
  const signer = signerFromPublicKey(publicKeyHexFromPrivate(signingKey));
  if (signer === null) throw new Error('[immune] signComponentAttestation: signingKey is not an Ed25519 private key');
  const signature = `0x${sign(null, Buffer.from(attestationSigningMessage(domain, payload), 'utf8'), signingKey).toString('hex')}`;
  return { payload, signer, signature };
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
  /** true only when the receipt asserts `authoritative: true`. A green `ok` with `authoritative: false` is a demo, not a trust anchor. */
  authoritative: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const eqHex = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/** result ↔ verified_correct must agree: correct↔correct, incorrect↔incorrect, not_scorable↔missing_evaluation. */
function resultConsistentWith(result: unknown, verifiedCorrect: unknown): boolean {
  if (result === 'correct') return verifiedCorrect === 'correct';
  if (result === 'incorrect') return verifiedCorrect === 'incorrect';
  if (result === 'not_scorable') return verifiedCorrect === 'missing_evaluation';
  return false;
}

/**
 * Verify one embedded component attestation under its own domain and trust root. Returns the AUTHENTIC
 * payload for cross-matching, or null when the attestation is malformed or its signature does not verify
 * (in which case its payload cannot be trusted and no cross-match is attempted). An untrusted-but-valid
 * signature still returns the payload — the receipt is already refused, but the mismatch reasons stay useful.
 *
 * `kind` is the short role name: refuses `${kind}_attestation_invalid` / `${kind}_untrusted_signer`.
 */
function verifyComponent(
  att: unknown,
  domain: string,
  roots: readonly { fingerprint: string }[],
  kind: 'sandbox' | 'evaluation' | 'settlement',
  refuse: (reason: string) => void,
): Record<string, unknown> | null {
  if (!isObj(att) || !isObj(att['signer']) || typeof att['signature'] !== 'string' || !isObj(att['payload'])) {
    refuse(`${kind}_attestation_invalid`);
    return null;
  }
  const signer = att['signer'] as unknown as ReceiptSigner;
  const signature = att['signature'] as string;
  const message = attestationSigningMessage(domain, att['payload']);
  if (
    signerFromPublicKey(signer.public_key)?.fingerprint !== signer.fingerprint.toLowerCase() ||
    !verifyEd25519(signer.public_key, message, signature)
  ) {
    refuse(`${kind}_attestation_invalid`);
    return null;
  }
  if (!roots.some((t) => t.fingerprint.toLowerCase() === signer.fingerprint.toLowerCase())) {
    refuse(`${kind}_untrusted_signer`);
  }
  return att['payload'] as Record<string, unknown>;
}

/**
 * An INDEPENDENT verifier. ok=true only when the composite AND all three component attestations are
 * authentic, every binding holds, and no dishonest combination is claimed. Never throws, never mutates.
 * `seenExperimentIds` is how a replay is caught: the caller passes the ids it has already honoured; this
 * function reports a hit, the caller records the id after a clean verify.
 *
 * NOTE (back-compat): `trustRoots` replaced the old single trusted-signer list. Pass a
 * CombinedReceiptTrustRoots with one pinned set per role (combined / sandbox / evaluation / settlement).
 *
 * REFUSES (ok=false) when, among others:
 *  (1) the composite signature is missing/invalid or its signer is not trusted under trustRoots.combined;
 *  (2) any component attestation's signature is invalid (`<kind>_attestation_invalid`) or its signer is
 *      not trusted for that role (`<kind>_untrusted_signer`) — this is the Issue-A forged-combination defense;
 *  (3) a bound identifier diverges from its signed component (`identifier_mismatch:<field>`);
 *  (4) independence is claimed yet the SIGNED evaluation's checker_controller equals the maker's (`false_independence`);
 *  (5) a dishonest settlement pairing is claimed (`incorrect_claimed_success`, `correct_settled_as_failure`,
 *      `settled_outcome_mismatch`) or a score settled on an un-evaluated deliverable (`settled_without_evaluation`);
 *  (6) the content_hash no longer matches the body, or experiment_id has already been seen (replay).
 */
export function verifyCombinedReceipt(
  receipt: unknown,
  trustRoots: CombinedReceiptTrustRoots,
  seenExperimentIds: ReadonlySet<string> = new Set(),
): CombinedReceiptVerification {
  const reasons: string[] = [];
  const refuse = (reason: string): void => {
    reasons.push(reason);
  };

  if (!isObj(receipt) || !isObj(receipt['identities'])) {
    return { ok: false, reasons: ['malformed'], authoritative: false };
  }
  // Surfaced in the result (never a refusal): a demo receipt (authoritative !== true) verifies fine but is no trust anchor.
  const authoritative = receipt['authoritative'] === true;
  const r = receipt as unknown as SignedCombinedReceipt;

  // (1) composite signature present, verifies under its named key, and that key is trusted for the composite role.
  const signer = (r as { signer?: ReceiptSigner }).signer;
  const signature = (r as { signature?: string }).signature;
  if (!isObj(signer) || typeof signature !== 'string') {
    refuse('unsigned');
  } else if (signerFromPublicKey(signer.public_key)?.fingerprint !== signer.fingerprint.toLowerCase()) {
    refuse('signer_fingerprint_mismatch');
  } else if (!verifyEd25519(signer.public_key, combinedReceiptSigningMessage(r), signature)) {
    refuse('signature_invalid');
  } else if (!trustRoots.combined.some((t) => t.fingerprint.toLowerCase() === signer.fingerprint.toLowerCase())) {
    refuse('untrusted_signer');
  }

  // content_hash binding: no bound field may have moved since signing.
  if (r.content_hash !== combinedReceiptContentHash(r)) refuse('content_hash_mismatch');

  // (2) ground the components: each embedded attestation must be authentic under its OWN trust root.
  const sandbox = verifyComponent(receipt['sandbox_attestation'], SANDBOX_ATTESTATION_DOMAIN, trustRoots.sandbox, 'sandbox', refuse);
  const evaluation = verifyComponent(receipt['evaluation_attestation'], EVALUATION_ATTESTATION_DOMAIN, trustRoots.evaluation, 'evaluation', refuse);
  const settlement = verifyComponent(receipt['settlement_attestation'], SETTLEMENT_ATTESTATION_DOMAIN, trustRoots.settlement, 'settlement', refuse);

  // (3) cross-match the composite's bound ids against the SIGNED component payloads: a recombination diverges here.
  if (sandbox && !eqHex(r.artifact_hash, sandbox['artifact_sha256'])) refuse('identifier_mismatch:artifact_hash');
  if (settlement && r.experiment_id !== settlement['experiment_id']) refuse('identifier_mismatch:experiment_id');
  if (evaluation && r.evaluation_version !== evaluation['evaluation_version']) refuse('identifier_mismatch:evaluation_version');
  if (settlement && r.settlement_event_id !== settlement['settlement_event_id']) refuse('identifier_mismatch:settlement_event_id');
  if (settlement && r.settlement_outcome !== settlement['settlement_outcome']) refuse('identifier_mismatch:settlement_outcome');
  if (evaluation && !resultConsistentWith(r.result, evaluation['verified_correct'])) refuse('identifier_mismatch:result');

  // (4) never claim independence when the SIGNED evaluation's checker shares the maker's controller.
  if (
    r.independence_class === 'independent_counterparty' &&
    evaluation &&
    r.identities.maker_controller === evaluation['checker_controller']
  ) {
    refuse('false_independence');
  }

  // (5) settlement honesty. A verified-incorrect result MAY settle a negative delta ('failure'); it must never read as success.
  if ((r.result === 'incorrect' || r.result === 'not_scorable') && r.settlement_outcome === 'success') refuse('incorrect_claimed_success');
  if (r.result === 'correct' && r.settlement_outcome === 'failure') refuse('correct_settled_as_failure');
  if ((r.settled === true && r.settlement_outcome === 'none') || (r.settled === false && r.settlement_outcome !== 'none')) {
    refuse('settled_outcome_mismatch');
  }
  // a score cannot settle (success OR failure) on an un-evaluated deliverable; read the verdict from the SIGNED evaluation.
  const verifiedCorrect = evaluation ? evaluation['verified_correct'] : undefined;
  if (r.settled === true && (verifiedCorrect == null || verifiedCorrect === 'missing_evaluation')) refuse('settled_without_evaluation');

  // (6) replay.
  if (seenExperimentIds.has(r.experiment_id)) refuse('experiment_replayed');

  return { ok: reasons.length === 0, reasons, authoritative };
}
