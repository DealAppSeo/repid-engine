/**
 * HAL v2 — Tier 2: frontier-mini cross-check.
 *
 * Three frontier-mini models from the three major LLM families. Used when
 * Tier 1 splits or when the classifier puts the query outside the SLM
 * wheelhouse (multi-step reasoning, hard math, sensitive domain).
 *
 * Cost target: ~$0.001–0.003 per check across 3 parallel calls.
 */
import { ModelSpec, providerKeyAvailable, isMockMode } from './hal-providers';
import { runTier, TierResult } from './hal-tier1-slm';

const TIER2_DEFAULT_MODELS: ModelSpec[] = [
  // Anthropic Haiku 4.5 — fast small-frontier from Anthropic.
  { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5',
    cost_per_million_in_usd: 1.0, cost_per_million_out_usd: 5.0 },
  // OpenAI mini-tier (model id may evolve; gpt-5-mini reserved name)
  { provider: 'openai',    model: 'gpt-5-mini',                 display_name: 'GPT-5 mini',
    cost_per_million_in_usd: 0.25, cost_per_million_out_usd: 2.0 },
  // Google fast tier
  { provider: 'google',    model: 'gemini-2.5-flash',           display_name: 'Gemini 2.5 Flash',
    cost_per_million_in_usd: 0.30, cost_per_million_out_usd: 2.50 },
];

export function selectTier2Models(override?: ModelSpec[]): ModelSpec[] {
  if (override?.length) return override;
  if (isMockMode()) return TIER2_DEFAULT_MODELS;
  return TIER2_DEFAULT_MODELS.filter(m => providerKeyAvailable(m.provider));
}

export async function tier2MiniConsensus(
  query: string,
  claim: string,
  options?: { models?: ModelSpec[]; timeout_ms?: number },
): Promise<TierResult> {
  const models = selectTier2Models(options?.models);
  const timeoutMs = options?.timeout_ms ?? 8000;
  const r = await runTier(2, models, query, claim, timeoutMs);
  return r;
}
