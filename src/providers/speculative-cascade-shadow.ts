/**
 * speculative-cascade-shadow.ts — Shadow-only wiring for the ANFIS speculative cascade
 * (backlog item 8, reports/2026-07-26/PATENT_ALIGNED_BUILD_BACKLOG.md).
 *
 * WHAT THIS IS
 * ------------
 * `runSpeculativeCascade` (./speculative-cascade.ts) is a pure decision layer that needs
 * caller-injected draft() and escalate() functions returning a MEASURED output confidence.
 * As of 2026-09-16 no code in this repo produces a measured post-call output confidence —
 * `anfisConfidence` in router.ts is ANFIS's confidence in its routing recommendation,
 * computed BEFORE any provider call; it is not a score of what the model returned.
 *
 * This module fills the gap in the only honest way: a SHADOW-ONLY oracle that uses
 * `anfisConfidence` as a PROXY for draft quality and logs what the cascade would have
 * decided, without making any additional provider calls. It is a measurement step, not a
 * behaviour change.
 *
 * PROXY WARNING (documented, not papered over)
 * --------------------------------------------
 * Routing confidence ≠ output quality confidence. A high ANFIS routing confidence means
 * "ANFIS is sure this is the right tier for this task" — it does NOT mean the chosen
 * provider's output will score well on the content. The signal is correlated but noisy.
 * The shadow log includes `proxyWarning: true` on every record so any downstream
 * analysis knows this; switching from a proxy to a real output scorer is the future
 * wiring decision this shadow is designed to inform.
 *
 * GATING
 * ------
 * Completely inert unless `CASCADE_SPECULATION_ENABLED=true`. The gate is opt-in because
 * the shadow adds one console.log per request and a tiny sync computation to every
 * `routeRequest()` call. Setting the flag in a dev/staging environment gives the
 * measurement log without prod overhead.
 *
 * SHADOW-FIRST INVARIANT
 * ----------------------
 * This module NEVER calls `runSpeculativeCascade` with real async draft/escalate
 * functions — it calls it with synchronous stubs that return instantly. No real provider
 * call is made. No routing decision is changed.
 */

import {
  runSpeculativeCascade,
  CASCADE_CONFIDENCE_THRESHOLD,
  type CascadeDecision,
} from './speculative-cascade';

export interface CascadeShadowInput {
  /** ANFIS routing confidence for this request — used as the draft-quality PROXY. */
  anfisConfidence: number;
  /** Static (non-ANFIS) routing tier — 'slm' | '0a' | '1' | 'none'. */
  staticTier: string;
  /** ANFIS recommended tier — determines whether the shadow models a "draft cheap →
   *  escalate strong" scenario or a same-tier cascade. */
  anfisTier: string;
  /** Estimated cost of the "draft" (tier-0/SLM) model call in USD.
   *  Uses a conservative default if unknown. */
  draftEstimatedCostUsd?: number;
  /** Estimated cost of the "escalate" (tier-1) model call in USD.
   *  Uses a conservative default if unknown. */
  escalateEstimatedCostUsd?: number;
  /** Override the confidence threshold (default: CASCADE_CONFIDENCE_THRESHOLD). */
  confidenceThreshold?: number;
}

export interface CascadeShadowDecision extends CascadeDecision<'draft' | 'escalate'> {
  /** Always true in this shadow module — the draft confidence is not a real output score. */
  proxyWarning: true;
}

const DEFAULT_DRAFT_COST_USD = 0.0001;    // ~tier-0 free call
const DEFAULT_ESCALATE_COST_USD = 0.003; // ~tier-1 call, GPT-4-class

/**
 * Compute what the speculative cascade WOULD have decided for this request, given
 * `anfisConfidence` as a proxy for draft output quality. Runs fully synchronously
 * (stubs return their values instantly); no I/O, no provider calls.
 *
 * Returns `null` when `CASCADE_SPECULATION_ENABLED` is not set.
 */
export async function shadowCascadeDecision(
  input: CascadeShadowInput,
): Promise<CascadeShadowDecision | null> {
  if (process.env['CASCADE_SPECULATION_ENABLED'] !== 'true') return null;

  const draftCost = input.draftEstimatedCostUsd ?? DEFAULT_DRAFT_COST_USD;
  const escalateCost = input.escalateEstimatedCostUsd ?? DEFAULT_ESCALATE_COST_USD;

  // Stubs inject the proxy confidence and pre-estimated costs without making real calls.
  const decision = await runSpeculativeCascade<'draft' | 'escalate'>({
    draft: async () => ({
      output: 'draft' as const,
      confidence: input.anfisConfidence,
      costUsd: draftCost,
    }),
    escalate: async () => ({
      output: 'escalate' as const,
      confidence: 0.95, // conservative tier-1 assumption
      costUsd: escalateCost,
    }),
    escalateBaselineCostUsd: escalateCost,
    confidenceThreshold: input.confidenceThreshold ?? CASCADE_CONFIDENCE_THRESHOLD,
  });

  const shadow: CascadeShadowDecision = { ...decision, proxyWarning: true };

  console.log(
    '[CASCADE-SHADOW]',
    JSON.stringify({
      anfisConfidence: input.anfisConfidence,
      staticTier: input.staticTier,
      anfisTier: input.anfisTier,
      wouldEscalate: shadow.usedEscalation,
      estimatedSavedUsd: shadow.savedUsd,
      reason: shadow.reason,
      proxyWarning: true,
    }),
  );

  return shadow;
}
