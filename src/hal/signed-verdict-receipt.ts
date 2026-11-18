/**
 * A HAL verdict receipt that a third party can check with nothing but the receipt and a public key.
 *
 * Why. `hal_quorum_receipts` / `hal_quorum_validator_votes` are anon-writable until Sean's RLS DDL
 * lands, so a row's PRESENCE proves nothing: anyone can insert one. The only thing that makes a
 * receipt authentic is a signature from a key only the engine holds. This module builds that receipt
 * from the HAL response (no table read, no table write) and signs it with the kernel's Ed25519 key
 * under its own domain, so a HAL receipt signature can never be replayed as a kernel receipt or the
 * other way round.
 *
 * Verdicts are the eval ruler's (scripts/hal-eval/metrics.ts, scoring v3), so a receipt and an F1
 * row can never disagree about one item:
 *   CONTRADICTED  fact-check mode, >= 2 families, decision vetoed, and at least one checker voted FALSE
 *   SUPPORTED     fact-check mode, >= 2 families, decision clean or flagged (`decision` stays visible)
 *   NOT_CHECKED   everything else, ALWAYS with a reason code. Never a pass, never a zero-score fail.
 *
 * Off by default. withVerdictReceiptId attaches it only when HAL_SIGNED_RECEIPT_ENABLED is exactly
 * `true`; with the flag on and no KERNEL_RECEIPT_SIGNING_KEY it attaches an unsigned body marked
 * NOT_CHECKED `signing_key_unset`, never a fake signature.
 */
import { createHash } from 'crypto';
import { canonicalJson } from '../services/auditChainWriter';
import { kernelReceiptSigningKey, signerFromPublicKey, verifyEd25519 } from '../kernel/receipt-signing';
import type { ReceiptSigner } from '../kernel/types';
import { halVerdictReceiptId, type HalVerdictLike } from './verdict-receipt-id';

export const HAL_SIGNED_RECEIPT_VERSION = 'hal-signed-receipt-v1';
/** Prefixed to the signed bytes. Distinct from KERNEL_RECEIPT_SIGNATURE_DOMAIN on purpose. */
export const HAL_RECEIPT_SIGNATURE_DOMAIN = 'hyperdag.hal-receipt.signature.v1\n';

export type ReceiptVerdict = 'SUPPORTED' | 'CONTRADICTED' | 'NOT_CHECKED';

export interface ReceiptVote {
  provider: string;
  model: string;
  verdict: string; // TRUE | FALSE | UNCERTAIN | ERROR
  /** Present only when the checker failed. A code, never the provider's raw error text. */
  failure?: string;
  /** sha256 of the checker's note, so a holder of the note can tie it to this receipt. */
  note_sha256?: string;
}

export interface SignedHalReceipt {
  v: typeof HAL_SIGNED_RECEIPT_VERSION;
  /** 'halr1_' + sha256(canonicalJson(body)), where body is this object minus receipt_id/signer/signature. */
  receipt_id: string;
  /** The content-addressed verdict id (verdict-receipt-id.ts) this receipt seals. */
  verdict_receipt_id: string;
  verdict: ReceiptVerdict;
  reason: string;
  claim_sha256: string;
  decision: string;
  hal_score: number | null;
  mode: string | null;
  strictness: number | null;
  families_used: number;
  families: string[];
  votes: ReceiptVote[];
  /** Hashes a verifier can recompute from material it holds: the claim, each note. */
  evidence_refs: Array<{ kind: string; sha256: string }>;
  signer?: ReceiptSigner;
  /** Ed25519 over HAL_RECEIPT_SIGNATURE_DOMAIN + canonicalJson(receipt minus signature), 0x + 128 hex. */
  signature?: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** A provider failure as a reason code. Order matters: a 402 that mentions a rate is a credit refusal. */
export function failureCode(error: string): string {
  const e = error.toLowerCase();
  if (/\b40[23]\b|payment|credit|insufficient|billing|forbidden/.test(e)) return 'provider_refused_credit';
  if (/\b429\b|rate.?limit|too many requests|quota/.test(e)) return 'rate_limited';
  if (/timeout|timed out|abort/.test(e)) return 'timeout';
  if (/parse|json|unexpected token/.test(e)) return 'unparseable';
  if (/\b40[14]\b|unauthori[sz]ed|not found|invalid api key/.test(e)) return 'provider_auth_or_model';
  return 'provider_error';
}

function votesOf(v: HalVerdictLike): ReceiptVote[] {
  return (v.provider_responses ?? [])
    .map((raw) => {
      const p = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      const vote: ReceiptVote = {
        provider: String(p['provider'] ?? ''),
        model: String(p['model'] ?? ''),
        verdict: String(p['verdict'] ?? 'ERROR'),
      };
      if (typeof p['error'] === 'string' && p['error'] !== '') vote.failure = failureCode(p['error']);
      else if (vote.verdict === 'ERROR') vote.failure = 'provider_error';
      if (typeof p['note'] === 'string' && p['note'] !== '') vote.note_sha256 = sha256(p['note']);
      return vote;
    })
    .sort((a, b) => (a.provider + a.model).localeCompare(b.provider + b.model));
}

/** The three-way verdict and its reason, on the eval ruler's rules (scoring v3). */
export function receiptVerdictOf(v: HalVerdictLike, votes: ReceiptVote[], familiesUsed: number): { verdict: ReceiptVerdict; reason: string } {
  if (v.mode !== 'fact-check') return { verdict: 'NOT_CHECKED', reason: `not_fact_check_mode:${v.mode ?? 'unknown'}` };
  if (votes.length === 0 || votes.every((x) => x.verdict === 'ERROR')) {
    const codes = [...new Set(votes.map((x) => x.failure ?? 'provider_error'))].sort();
    return { verdict: 'NOT_CHECKED', reason: `all_providers_failed${codes.length ? ':' + codes.join(',') : ''}` };
  }
  if (/abstain/i.test(v.decision)) return { verdict: 'NOT_CHECKED', reason: 'abstain' };
  if (familiesUsed < 2) return { verdict: 'NOT_CHECKED', reason: `under_quorum:${familiesUsed}_families` };
  if (v.decision === 'vetoed') {
    return votes.some((x) => x.verdict === 'FALSE')
      ? { verdict: 'CONTRADICTED', reason: 'quorum_veto' }
      : { verdict: 'NOT_CHECKED', reason: 'veto_without_false_vote' };
  }
  if (v.decision === 'clean' || v.decision === 'flagged') return { verdict: 'SUPPORTED', reason: `quorum_${v.decision}` };
  return { verdict: 'NOT_CHECKED', reason: `unknown_decision:${v.decision}` };
}

function bodyOf(r: SignedHalReceipt) {
  const { receipt_id: _id, signer: _s, signature: _sig, ...body } = r;
  return body;
}

export function signingMessage(r: SignedHalReceipt): string {
  const { signature: _sig, ...rest } = r;
  return HAL_RECEIPT_SIGNATURE_DOMAIN + canonicalJson(rest);
}

/** Build the receipt (unsigned). Pure: no I/O, no env. */
export function buildHalReceipt(text: string, v: HalVerdictLike): SignedHalReceipt {
  const signals = v.signals ?? {};
  const familiesUsed = Number(signals['families_used'] ?? 0) || 0;
  const families = Array.isArray(signals['families']) ? [...new Set((signals['families'] as unknown[]).map(String))].sort() : [];
  const votes = votesOf(v);
  const { verdict, reason } = receiptVerdictOf(v, votes, familiesUsed);
  const claim_sha256 = sha256(text);
  const r: SignedHalReceipt = {
    v: HAL_SIGNED_RECEIPT_VERSION,
    receipt_id: '',
    verdict_receipt_id: halVerdictReceiptId(text, v),
    verdict,
    reason,
    claim_sha256,
    decision: v.decision,
    hal_score: typeof v.hal_score === 'number' && Number.isFinite(v.hal_score) ? Math.round(v.hal_score * 1e4) / 1e4 : null,
    mode: v.mode ?? null,
    strictness: v.strictness ?? null,
    families_used: familiesUsed,
    families,
    votes,
    evidence_refs: [
      { kind: 'claim', sha256: claim_sha256 },
      ...votes.filter((x) => x.note_sha256).map((x) => ({ kind: `note:${x.provider}`, sha256: x.note_sha256! })),
    ],
  };
  r.receipt_id = 'halr1_' + sha256(canonicalJson(bodyOf(r)));
  return r;
}

/**
 * Build and sign with the configured kernel key. No key: the receipt comes back unsigned with
 * verdict forced to NOT_CHECKED `signing_key_unset`, so an unsigned body never reads as a checked one.
 * A key that is set but broken throws (kernelReceiptSigningKey's fixed message), as the kernel does.
 */
export function signedHalReceipt(text: string, v: HalVerdictLike): SignedHalReceipt {
  const key = kernelReceiptSigningKey();
  const r = buildHalReceipt(text, v);
  if (key === null) {
    // no ';' in the reason: the body sanitizer refuses it when the receipt is posted back.
    const u: SignedHalReceipt = { ...r, verdict: 'NOT_CHECKED', reason: `signing_key_unset,would_be:${r.verdict}` };
    u.receipt_id = 'halr1_' + sha256(canonicalJson(bodyOf(u)));
    return u;
  }
  r.signer = key.signer;
  const message = signingMessage(r);
  if (key.leaks(message)) throw new Error('[hal] refusing to sign a receipt that contains the signing key');
  r.signature = key.sign(message);
  return r;
}

export type ReceiptCheck =
  | { verified: true; receipt_id: string; verdict: ReceiptVerdict; signer_fingerprint: string }
  | { verified: false; reason: string };

/**
 * Check a receipt against pinned public keys. Trusts the signature and the pin, never a table row.
 * Reasons: malformed, receipt_id_mismatch, unsigned, untrusted_signer, bad_signature, claim_mismatch.
 */
export function checkHalReceipt(input: unknown, trusted: ReceiptSigner[], claimText?: string): ReceiptCheck {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { verified: false, reason: 'malformed' };
  const r = input as SignedHalReceipt;
  if (r.v !== HAL_SIGNED_RECEIPT_VERSION || typeof r.receipt_id !== 'string') return { verified: false, reason: 'malformed' };
  if (r.receipt_id !== 'halr1_' + sha256(canonicalJson(bodyOf(r)))) return { verified: false, reason: 'receipt_id_mismatch' };
  if (!r.signer || typeof r.signature !== 'string') return { verified: false, reason: 'unsigned' };
  const claimed = signerFromPublicKey(String(r.signer.public_key));
  if (claimed === null || claimed.fingerprint !== String(r.signer.fingerprint).toLowerCase()) return { verified: false, reason: 'malformed' };
  // Pin by fingerprint (sha256 of the public key): the credential-safety test refuses `===` on key fields.
  if (!trusted.some((t) => t.fingerprint === claimed.fingerprint)) return { verified: false, reason: 'untrusted_signer' };
  if (!verifyEd25519(claimed.public_key, signingMessage(r), r.signature)) return { verified: false, reason: 'bad_signature' };
  if (claimText !== undefined && sha256(claimText) !== r.claim_sha256) return { verified: false, reason: 'claim_mismatch' };
  return { verified: true, receipt_id: r.receipt_id, verdict: r.verdict, signer_fingerprint: claimed.fingerprint };
}
