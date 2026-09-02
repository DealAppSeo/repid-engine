/**
 * HAL FAMILY-QUORUM RECEIPT WRITER (audit item, 2026-08-08 — default OFF).
 *
 * WHAT THIS CLOSES
 * ----------------
 * The SBFA/BFT quorum audit (docs/sprints/2026-07-12/XC_TASK23_SBFA_BFT_QUORUM_AUDIT.md §5)
 * found that the cross-family quorum veto IS enforced live (fact-check.ts computes distinct
 * independent families and a family-aware quorum) but is **never persisted** — the
 * family-DISJOINT receipt tables have ZERO rows because no writer exists. The staged DDL
 * (migrations/2026-07-13-hal-quorum-receipts.sql: `hal_quorum_receipts` +
 * `hal_quorum_validator_votes`) has never had a caller. Follow-up #1 of that audit is
 * exactly this: "implement §5 tables + async writer behind a flag (default off until
 * migration applied)."
 *
 * This module is that writer. It maps a `FactCheckResult` (the live quorum decision produced
 * by `factCheck()`) into ONE panel receipt row + N per-provider validator-vote rows, carrying
 * the disjoint-family metadata (`families`, `families_unmapped`, per-vote `family`) that is
 * the whole point of the family-independence quorum.
 *
 * SAFETY / HONESTY
 * ----------------
 * - **Default OFF.** `writeQuorumReceipt` is a NO-OP unless `HAL_QUORUM_RECEIPT_ENABLED` is
 *   `true`/`on`/`1`. Importing this module changes nothing; the live scoring path is
 *   byte-identical until the flag is enabled AND the migration is applied.
 * - **Injectable client.** The Supabase-shaped client is a PARAMETER, so tests write a
 *   synthetic quorum decision into an in-memory fake — never prod. (The migration is not yet
 *   applied to prod anyway; enabling this against prod is a Sean-gated action.)
 * - **Never throws.** Designed for fire-and-forget (`setImmediate`) use off the scoring hot
 *   path — any DB error is caught and logged, and the scoring decision is never blocked.
 * - **`buildQuorumReceipt` is a PURE function** (no I/O), so the row shape is unit-testable
 *   without a client at all.
 *
 * This does NOT change any veto/flag threshold, does NOT mutate RepID, and does NOT touch the
 * TrustTrader on-chain `trinity_receipt_bft_results` path (a different, on-chain-reveal domain).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { familyOfResolved, type FactCheckResult, type ProviderVerdict } from './fact-check';
import { pageOperator } from '../services/operator-pager';

/** Row shape for `public.hal_quorum_receipts` (mirrors migrations/2026-07-13-hal-quorum-receipts.sql). */
export interface QuorumReceiptRow {
  score_event_id: number | null;
  quorum_id: string;
  agent_id: string | null;
  decision: string; // vetoed|flagged|clean|abstain
  scoring_decision: string; // coarse veto|pass AFTER neutralization
  quorum_met: boolean;
  families_used: number;
  providers_used: number;
  families: string[];
  families_unmapped: string[];
  agreement: number | null;
  hal_score: number | null;
  hal_mode: string | null; // fact-check|extractor|extractor-fallback
  sbfa_decision: string | null;
  sbfa_belief: number | null;
  sbfa_ignorance: number | null;
  decision_source: string | null;
}

/** Row shape for `public.hal_quorum_validator_votes` (receipt_id filled after the receipt insert). */
export interface QuorumValidatorVoteRow {
  provider: string;
  model: string | null;
  family: string;
  verdict: string; // TRUE|FALSE|UNCERTAIN|ERROR
  confidence: number | null;
  latency_ms: number | null;
  error: string | null;
}

/** Caller-supplied context that the `FactCheckResult` alone does not carry. All optional. */
export interface QuorumReceiptContext {
  /** correlates the receipt with the quorum's llm_call_log rows (fact-check's per-quorum id). */
  quorumId: string;
  /** repid_score_events id when the receipt is tied to a concrete scoring event. */
  scoreEventId?: number | null;
  agentId?: string | null;
  /** the neutralized scoring outcome, if the caller computed it; else derived from `decision`. */
  scoringDecision?: string;
  /** whether a valid independent quorum was met, if known; else derived from families_used>=2. */
  quorumMet?: boolean;
  /** fact-check|extractor|extractor-fallback. Default 'fact-check'. */
  halMode?: string;
  /** what drove the final decision (quorum|sbfa|retrieval|grok-tiebreak). Default derived. */
  decisionSource?: string;
  /**
   * per-provider family map as the LIVE quorum classified it (fact-check's internal familyByName).
   * When absent, each vote's family falls back to `familyOfResolved(vote.model)` — the SAME resolver
   * the live path uses — so the receipt is faithful either way.
   */
  familyByProvider?: Map<string, string>;
}

const MIN_QUORUM_FAMILIES = 2; // mirrors MIN_QUORUM_FOR_VETO in fact-check.ts

/** True iff the writer is explicitly enabled. Default OFF — any other value is a no-op. */
export function quorumReceiptWriteEnabled(): boolean {
  const v = (process.env.HAL_QUORUM_RECEIPT_ENABLED ?? '').trim().toLowerCase();
  return v === 'true' || v === 'on' || v === '1';
}

/** Sample rate in [0,1] for enabled writes (default 1.0). Lets volume be throttled without a code change. */
function sampleHit(): boolean {
  const r = Number(process.env.HAL_QUORUM_RECEIPT_SAMPLE_RATE);
  const rate = Number.isFinite(r) && r >= 0 && r <= 1 ? r : 1.0;
  return Math.random() < rate;
}

/** Coarse veto|pass from the HAL decision (only 'vetoed' is a veto; flagged/clean/abstain pass scoring). */
function coarseScoringDecision(decision: FactCheckResult['decision']): string {
  return decision === 'vetoed' ? 'veto' : 'pass';
}

/**
 * PURE mapping: `FactCheckResult` (+ context) -> one receipt row + N vote rows. No I/O; fully testable.
 * The per-vote `family` uses the caller's live classification when supplied, else the registry-primary
 * `familyOfResolved` fallback (never throws). `families`/`families_unmapped` are copied straight from the
 * quorum result — this is the disjoint-family metadata the receipt exists to preserve.
 */
export function buildQuorumReceipt(
  result: FactCheckResult,
  ctx: QuorumReceiptContext,
): { receipt: QuorumReceiptRow; votes: QuorumValidatorVoteRow[] } {
  const families = result.families ?? [];
  const familiesUnmapped = result.families_unmapped ?? [];
  const familiesUsed = result.families_used ?? families.length;

  const quorumMet = ctx.quorumMet ?? familiesUsed >= MIN_QUORUM_FAMILIES;

  // A FAILED QUORUM PAGES THE OPERATOR, and the trigger is the system's OWN gate rather than a
  // provider count someone picked.
  //
  // MEASURED 2026-09-01 across 44 events / 30 days: provider participation ranges 2..5 and
  // families 2..5, and `quorum_met` was TRUE at every single point — including at 2 providers /
  // 2 families. A hand-chosen floor of 3 would therefore have paged on 15 of those 44 events
  // (34%) that the system itself considers healthy, which is how a channel gets muted. There is
  // no defensible provider-count floor in this data; `familiesUsed < MIN_QUORUM_FAMILIES` is the
  // one boundary that never fired in normal operation, so it is the one worth waking someone for.
  //
  // (Sample is small — 44 events in 30 days. It is enough to rule OUT a floor above 2, which is
  // what it is used for here; it is not enough to characterise the tail.)
  if (!quorumMet) {
    pageOperator(
      'hal',
      'cross-provider quorum NOT met — a verdict was produced without the family diversity the gate requires',
      { families_used: familiesUsed, providers_used: result.providers_used, min_families: MIN_QUORUM_FAMILIES },
    );
  }

  const receipt: QuorumReceiptRow = {
    score_event_id: ctx.scoreEventId ?? null,
    quorum_id: ctx.quorumId,
    agent_id: ctx.agentId ?? null,
    decision: result.decision,
    scoring_decision: ctx.scoringDecision ?? coarseScoringDecision(result.decision),
    quorum_met: quorumMet,
    families_used: familiesUsed,
    providers_used: result.providers_used,
    families,
    families_unmapped: familiesUnmapped,
    agreement: result.agreement,
    hal_score: result.hal_score,
    hal_mode: ctx.halMode ?? 'fact-check',
    sbfa_decision: result.sbfa?.decision ?? null,
    sbfa_belief: result.sbfa?.belief ?? null,
    sbfa_ignorance: result.sbfa?.ignorance_mass ?? null,
    decision_source:
      ctx.decisionSource ??
      (result.sbfa?.enforced ? 'sbfa' : result.retrieval?.refined ? 'retrieval' : 'quorum'),
  };

  const votes: QuorumValidatorVoteRow[] = (result.verdicts ?? []).map((v: ProviderVerdict) => ({
    provider: v.provider,
    model: v.model ?? null,
    family: ctx.familyByProvider?.get(v.provider) ?? familyOfResolved(v.model ?? v.provider),
    verdict: v.verdict,
    confidence: Number.isFinite(v.confidence) ? v.confidence : null,
    latency_ms: Number.isFinite(v.latency_ms) ? v.latency_ms : null,
    error: v.error ?? null,
  }));

  return { receipt, votes };
}

export interface QuorumReceiptWriteResult {
  written: boolean;
  receiptId?: number;
  voteCount?: number;
  /** why nothing was written: 'flag-off' | 'sampled-out' | 'receipt-error' | 'exception'. */
  skippedReason?: string;
  error?: string;
}

/**
 * Persist ONE quorum receipt + its validator votes via the injected client. Gated by
 * `HAL_QUORUM_RECEIPT_ENABLED` (default OFF) and `HAL_QUORUM_RECEIPT_SAMPLE_RATE`. Never throws.
 *
 * Two-step insert: the receipt first (RETURNING id), then the votes carrying that receipt_id. If the
 * receipt insert fails, votes are not attempted. A vote-insert failure is logged but still reports the
 * receipt as written (the panel row is the durable audit anchor; votes are the detail).
 */
export async function writeQuorumReceipt(
  client: Pick<SupabaseClient, 'from'>,
  result: FactCheckResult,
  ctx: QuorumReceiptContext,
): Promise<QuorumReceiptWriteResult> {
  if (!quorumReceiptWriteEnabled()) return { written: false, skippedReason: 'flag-off' };
  if (!sampleHit()) return { written: false, skippedReason: 'sampled-out' };

  try {
    const { receipt, votes } = buildQuorumReceipt(result, ctx);

    const { data, error } = await client
      .from('hal_quorum_receipts')
      .insert(receipt)
      .select('id')
      .single();

    if (error || !data) {
      console.error(
        `[hal] hal_quorum_receipt write FAILED (receipt): ${error?.message ?? 'no id returned'} ` +
          `(quorum_id=${ctx.quorumId})`,
      );
      return { written: false, skippedReason: 'receipt-error', error: error?.message };
    }

    const receiptId = (data as { id: number }).id;

    if (votes.length > 0) {
      const voteRows = votes.map((v) => ({ ...v, receipt_id: receiptId }));
      const { error: voteErr } = await client.from('hal_quorum_validator_votes').insert(voteRows);
      if (voteErr) {
        // Receipt is durable; log the vote-detail loss but do not fail the write.
        console.error(
          `[hal] hal_quorum_receipt votes write FAILED (receipt_id=${receiptId}): ${voteErr.message}`,
        );
      }
    }

    return { written: true, receiptId, voteCount: votes.length };
  } catch (e: any) {
    // Fire-and-forget safety: never let a receipt write throw into the scoring path.
    console.error(`[hal] hal_quorum_receipt write EXCEPTION (quorum_id=${ctx.quorumId}): ${e?.message ?? e}`);
    return { written: false, skippedReason: 'exception', error: e?.message ?? String(e) };
  }
}
