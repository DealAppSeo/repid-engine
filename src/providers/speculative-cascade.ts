/**
 * speculative-cascade.ts — ANFIS SPECULATIVE CASCADE axis (backlog item 8,
 * reports/2026-07-26/PATENT_ALIGNED_BUILD_BACKLOG.md).
 *
 * Neither existing neighbor is this mechanism (investigated by beat 75, 2026-08-30, and
 * confirmed again here): `selectSlmRoute` (./slm-tier.ts) routes to a cheap SLM from a
 * caller-DECLARED `confidence_required` threshold, decided BEFORE any call is made.
 * `applyEscalationOnly` (../services/anfis-escalation-gate.ts) escalates provider TIER from
 * ANFIS's routing recommendation vs the static router. Neither one runs a cheap draft, scores
 * its ACTUAL output confidence, and conditionally re-runs on a stronger model from that
 * measured result.
 *
 * This module is that missing piece: a pure decision layer (no I/O, no provider calls) that
 * takes caller-injected `draft()`/`escalate()` functions, each already having run and reporting
 * a measured `{output, confidence, costUsd}`. It decides whether the draft's confidence clears
 * the bar; if not, it escalates. `escalateBaselineCostUsd` is the cost of an "always run the
 * strong model" baseline, supplied by the caller so the savings figure is comparable even on
 * the accept-draft path, where escalate() never actually runs.
 *
 * Deliberately not wired into `src/providers/router.ts` or any route this beat — which live
 * call sites adopt cascading (and how `draft`/`escalate` map to real provider calls) is a
 * follow-up decision, not squeezed into this beat's turn budget.
 */

export const CASCADE_CONFIDENCE_THRESHOLD = 0.7;

export interface CascadeAttempt<T> {
  output: T;
  confidence: number;
  costUsd: number;
}

export interface CascadeInput<T> {
  draft: () => Promise<CascadeAttempt<T>>;
  escalate: () => Promise<CascadeAttempt<T>>;
  /** Cost of the "always run the strong model" baseline — used for the savings calc even
   *  on the accept-draft path, where `escalate()` is never actually invoked. */
  escalateBaselineCostUsd: number;
  confidenceThreshold?: number;
}

export interface CascadeDecision<T> {
  output: T;
  usedEscalation: boolean;
  draftConfidence: number;
  finalConfidence: number;
  costUsd: number;
  baselineCostUsd: number;
  /** Positive = cheaper than always-escalating. Negative on the escalated path means the
   *  draft attempt was wasted spend (draft cost + escalate cost > baseline). */
  savedUsd: number;
  reason: string;
}

/**
 * Run a cheap draft, escalate to a stronger model only if the draft's measured confidence
 * falls below `confidenceThreshold` (default `CASCADE_CONFIDENCE_THRESHOLD`).
 */
export async function runSpeculativeCascade<T>(input: CascadeInput<T>): Promise<CascadeDecision<T>> {
  const threshold = input.confidenceThreshold ?? CASCADE_CONFIDENCE_THRESHOLD;
  const draft = await input.draft();

  if (draft.confidence >= threshold) {
    return {
      output: draft.output,
      usedEscalation: false,
      draftConfidence: draft.confidence,
      finalConfidence: draft.confidence,
      costUsd: draft.costUsd,
      baselineCostUsd: input.escalateBaselineCostUsd,
      savedUsd: Math.max(0, input.escalateBaselineCostUsd - draft.costUsd),
      reason: `draft confidence ${draft.confidence} >= threshold ${threshold} — accepted without escalation`,
    };
  }

  const escalated = await input.escalate();
  const totalCost = draft.costUsd + escalated.costUsd;
  return {
    output: escalated.output,
    usedEscalation: true,
    draftConfidence: draft.confidence,
    finalConfidence: escalated.confidence,
    costUsd: totalCost,
    baselineCostUsd: input.escalateBaselineCostUsd,
    savedUsd: input.escalateBaselineCostUsd - totalCost,
    reason: `draft confidence ${draft.confidence} < threshold ${threshold} — escalated to stronger model`,
  };
}
