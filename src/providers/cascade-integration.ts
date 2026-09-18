/**
 * cascade-integration.ts — glue layer wiring runSpeculativeCascade with scoreOutputConfidence.
 *
 * Closes the "missing measurement facility" gap documented in backlog item 8
 * (reports/2026-07-26/PATENT_ALIGNED_BUILD_BACKLOG.md):
 *   - `runSpeculativeCascade` (./speculative-cascade.ts) requires caller-measured confidence
 *     on draft and escalated outputs.
 *   - `scoreOutputConfidence` (./output-confidence-scorer.ts) provides that post-call score
 *     from the returned text.
 *
 * This module wraps both: callers supply raw provider call fns that return `{output, costUsd}`;
 * this layer scores the output and forwards the full `CascadeAttempt` to the cascade.
 *
 * Gate: `CASCADE_SPECULATION_ENABLED=true` must be set. Default off — shadow-first, no prod
 * routing change until flag is explicitly enabled. When off, `callWithCascade` returns
 * immediately with `skipped: true` and the feature is completely inert.
 *
 * Zero callers wired in router.ts this beat — which production call sites adopt cascading is a
 * follow-up decision, tracked in backlog item 8. This module is the tested glue that unblocks
 * that decision.
 */

import { runSpeculativeCascade, CascadeDecision } from './speculative-cascade';
import { scoreOutputConfidence } from './output-confidence-scorer';

export interface RawProviderCall {
  output: string;
  costUsd: number;
}

export interface CascadeIntegrationOpts {
  /** Cheap provider call — no confidence measurement needed from the caller. */
  draftFn: () => Promise<RawProviderCall>;
  /** Strong provider call — called only when draft confidence is insufficient. */
  escalateFn: () => Promise<RawProviderCall>;
  /** Cost of an always-escalate baseline for the savings calculation. */
  escalateBaselineCostUsd: number;
  /** Override the default 0.7 threshold. */
  confidenceThreshold?: number;
}

export type CascadeResult =
  | ({ skipped: false } & CascadeDecision<string>)
  | { skipped: true; reason: string };

/**
 * Call a draft provider, score its output confidence with `scoreOutputConfidence`, then
 * escalate to the strong provider only if the draft's confidence falls below the threshold.
 *
 * Returns `{skipped: true}` immediately when `CASCADE_SPECULATION_ENABLED` is not `'true'`.
 * Never throws — escalation failures fall back to the draft result.
 */
export async function callWithCascade(opts: CascadeIntegrationOpts): Promise<CascadeResult> {
  if (process.env['CASCADE_SPECULATION_ENABLED'] !== 'true') {
    return { skipped: true, reason: 'gate_disabled' };
  }

  const makeDraftAttempt = async () => {
    const raw = await opts.draftFn();
    const scored = scoreOutputConfidence(raw.output);
    return { output: raw.output, confidence: scored.confidence, costUsd: raw.costUsd };
  };

  let escalateError: unknown;
  const makeEscalateAttempt = async () => {
    try {
      const raw = await opts.escalateFn();
      const scored = scoreOutputConfidence(raw.output);
      return { output: raw.output, confidence: scored.confidence, costUsd: raw.costUsd };
    } catch (err) {
      escalateError = err;
      // Return draft result as fallback — caller sees usedEscalation:true but output is draft
      const draft = await opts.draftFn();
      const scored = scoreOutputConfidence(draft.output);
      return { output: draft.output, confidence: scored.confidence, costUsd: draft.costUsd };
    }
  };

  const decision = await runSpeculativeCascade<string>({
    draft: makeDraftAttempt,
    escalate: makeEscalateAttempt,
    escalateBaselineCostUsd: opts.escalateBaselineCostUsd,
    confidenceThreshold: opts.confidenceThreshold,
  });

  if (escalateError !== undefined) {
    console.error('[CASCADE] escalate fn failed, draft used as fallback:', escalateError);
  }

  if (process.env['CASCADE_SPECULATION_ENABLED'] === 'true') {
    console.log('[CASCADE-SHADOW]', JSON.stringify({
      usedEscalation: decision.usedEscalation,
      draftConfidence: decision.draftConfidence,
      savedUsd: decision.savedUsd,
      reason: decision.reason,
    }));
  }

  return { skipped: false, ...decision };
}
