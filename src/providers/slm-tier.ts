/**
 * slm-tier.ts — "ultra cheap SLM" routing tier below the cheap-LLM tier (CC1, 2026-05-26).
 *
 * ANFIS currently bottoms out at the cheap-LLM tier (Groq llama-3.1-8b). For the cheapest
 * task classes — classification, routing decisions, quick fact-checks — where a low
 * confidence bar is acceptable, we can route to a small/fast model and only escalate to
 * an LLM when needed. This module is the pure decision layer (no I/O) so it is trivially
 * unit-testable; the ANFIS handler supplies provider availability + does the recording.
 *
 * Decision: task_type ∈ SLM_ELIGIBLE_TASKS AND confidence_required < SLM_CONFIDENCE_THRESHOLD
 * → route to the first AVAILABLE SLM (primary → backup); otherwise null (caller uses the
 * normal LLM tier). Threshold defaults conservative at 0.6: we only drop to an SLM when a
 * sub-0.6 confidence requirement signals the task tolerates a smaller model. Anything that
 * needs ≥0.6 confidence stays on the LLM tier.
 */
import { calculateCost } from '../billing/pricing';

export const SLM_ELIGIBLE_TASKS = ['classification', 'routing_decision', 'quick_check'] as const;
export type SlmEligibleTask = typeof SLM_ELIGIBLE_TASKS[number];

// Conservative default: route to SLM only when the task's required confidence is below this.
export const SLM_CONFIDENCE_THRESHOLD = 0.6;

export interface SlmModel { provider: string; model: string; }

// V1 picks (keys present in prod): primary = Groq llama-3.1-8b-instant (cheapest at
// $0.05/$0.08 per 1M, very low latency); backup = Cerebras llama3.1-8b (ultra-low latency,
// independent provider for failover). Both already have adapters + pricing in-repo.
export const SLM_PRIMARY: SlmModel = { provider: 'groq', model: 'llama-3.1-8b-instant' };
export const SLM_BACKUP: SlmModel = { provider: 'cerebras', model: 'zai-glm-4.7' };

// Baseline for the cost-saved metric: the "cheap LLM" the task would otherwise use.
// Conservative — this is the cheapest mid LLM, not a tier-1 model, so savings are not inflated.
export const SLM_BASELINE_LLM: SlmModel = { provider: 'groq', model: 'llama-3.1-70b-versatile' };

export interface SlmDecision {
  tier: '0a';
  provider: string;
  model: string;
  fallback: SlmModel; // the other SLM, for the caller's chain
  reason: string;
}

/**
 * Returns an SLM route decision, or null to fall through to the normal LLM tier.
 * `available(model)` lets the caller gate on provider health / key presence — if no SLM
 * is available the function returns null so the caller falls back to the cheapest LLM
 * (an SLM outage must degrade to an LLM, never to a hard failure).
 */
export function selectSlmRoute(
  taskType: string | undefined,
  confidenceRequired: number | undefined,
  available: (m: SlmModel) => boolean = () => true,
): SlmDecision | null {
  if (!taskType || !(SLM_ELIGIBLE_TASKS as readonly string[]).includes(taskType)) return null;
  // If confidence_required is unspecified, assume a high bar (1.0) → stay on the LLM tier.
  const conf = typeof confidenceRequired === 'number' ? confidenceRequired : 1;
  if (conf >= SLM_CONFIDENCE_THRESHOLD) return null;

  const candidates: SlmModel[] = [SLM_PRIMARY, SLM_BACKUP];
  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i]!;
    if (available(m)) {
      return {
        tier: '0a',
        provider: m.provider,
        model: m.model,
        fallback: candidates[(i + 1) % candidates.length]!,
        reason: `${taskType} with confidence_required ${conf} < ${SLM_CONFIDENCE_THRESHOLD} → ultra-cheap SLM ${m.provider}/${m.model}`,
      };
    }
  }
  return null; // no SLM available → caller falls back to cheapest LLM tier
}

export interface SlmSavings { slm_cost_usd: number; baseline_cost_usd: number; saved_usd: number; baseline: SlmModel; }

/** $ saved by routing to an SLM vs the cheap-LLM baseline (clamped at 0). */
export function estimateSlmSavings(
  tokensIn: number,
  tokensOut: number,
  slm: SlmModel = SLM_PRIMARY,
  baseline: SlmModel = SLM_BASELINE_LLM,
): SlmSavings {
  const slmCost = calculateCost(slm.provider, slm.model, tokensIn, tokensOut);
  const baseCost = calculateCost(baseline.provider, baseline.model, tokensIn, tokensOut);
  return { slm_cost_usd: slmCost, baseline_cost_usd: baseCost, saved_usd: Math.max(0, baseCost - slmCost), baseline };
}
