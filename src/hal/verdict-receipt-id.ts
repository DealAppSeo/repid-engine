/**
 * A HAL verdict's receipt id: a sha256 over the verdict record, prefixed `halv1_`.
 *
 * Why it exists. Every `trustshell verify` printed `receipt-id NOT_CHECKED`: the only receipt path
 * is a database row (hal_quorum_receipts, 0 rows on 2026-11-16, writer flag off), so no verdict had
 * an id anyone could cite. This id needs no table. Anyone holding the same record recomputes the same
 * id, so a verdict can be cited by TrustShell and, later, bound into a zkRepID epoch input.
 *
 * What it covers: the sha256 of the judged text (never the text), the decision, hal_score to 4
 * places, mode, strictness, whether a 2-family quorum formed, the families, and each provider's
 * (provider, model, verdict). It leaves out latency, timestamps and cache markers, so a cached
 * replay of a verdict has the same id as the verdict, and a fresh re-judgment that differs in any
 * covered field gets a new one.
 *
 * Content-addressed by design: two identical judgments of the same text share an id. Link a
 * verdict to an event (a score event, a contract) beside the id, never inside it.
 */
import { createHash } from 'crypto';
import { canonicalJson } from '../services/auditChainWriter';

export const HAL_VERDICT_RECEIPT_VERSION = 'hal-verdict-v1';

/** The fields of a HAL result the id reads. Every HalEvaluationResponse fits this shape. */
/**
 * How many leading characters of a claim the fact-check prompt shows the checkers (fact-check.ts
 * slices to this). A receipt records it, so a verdict is never read as covering text no model saw.
 */
export const HAL_JUDGED_CHARS = 1200;

export interface HalVerdictLike {
  decision: string;
  hal_score: number | null | undefined;
  mode?: string | null;
  strictness?: number | null;
  signals?: Record<string, unknown> | null;
  provider_responses?: ReadonlyArray<unknown> | null;
}

/** The record the id is the hash of. Exported so a verifier can rebuild it. */
export function halVerdictRecord(text: string, v: HalVerdictLike) {
  const signals = v.signals ?? {};
  const familiesUsed = Number(signals['families_used'] ?? signals['providers_used'] ?? 0);
  const families = Array.isArray(signals['families'])
    ? [...new Set((signals['families'] as unknown[]).map(String))].sort()
    : [];
  const votes = (v.provider_responses ?? [])
    .map((raw) => {
      const p = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      return { provider: String(p['provider'] ?? ''), model: String(p['model'] ?? ''), verdict: String(p['verdict'] ?? '') };
    })
    .sort((a, b) => (a.provider + a.model).localeCompare(b.provider + b.model));
  return {
    v: HAL_VERDICT_RECEIPT_VERSION,
    text_sha256: createHash('sha256').update(text).digest('hex'),
    decision: v.decision,
    hal_score: typeof v.hal_score === 'number' && Number.isFinite(v.hal_score) ? Math.round(v.hal_score * 1e4) / 1e4 : null,
    mode: v.mode ?? null,
    strictness: v.strictness ?? null,
    quorum_met: v.mode === 'fact-check' && familiesUsed >= 2,
    families,
    votes,
  };
}

export function halVerdictReceiptId(text: string, v: HalVerdictLike): string {
  return 'halv1_' + createHash('sha256').update(canonicalJson(halVerdictRecord(text, v))).digest('hex');
}

/**
 * Off unless HAL_VERDICT_RECEIPT_ID_ENABLED is exactly `true`. Off = the response is unchanged.
 * HAL_SIGNED_RECEIPT_ENABLED (exactly `true`, independent flag, default off) also attaches
 * `signed_receipt` (signed-verdict-receipt.ts). Both off = byte-identical to before.
 */
export function withVerdictReceiptId<T extends HalVerdictLike>(text: string, body: T): T | (T & { receipt_id?: string; signed_receipt?: unknown }) {
  const idOn = process.env.HAL_VERDICT_RECEIPT_ID_ENABLED === 'true';
  const signedOn = process.env.HAL_SIGNED_RECEIPT_ENABLED === 'true';
  if (!idOn && !signedOn) return body;
  // Required here, not at the top: signed-verdict-receipt imports this module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const signed = signedOn ? (require('./signed-verdict-receipt') as typeof import('./signed-verdict-receipt')).signedHalReceipt(text, body) : undefined;
  return {
    ...body,
    ...(idOn ? { receipt_id: halVerdictReceiptId(text, body) } : {}),
    ...(signed ? { signed_receipt: signed } : {}),
  };
}
