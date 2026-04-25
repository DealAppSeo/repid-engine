/**
 * HAL v2 — Tier 3: full frontier consensus.
 *
 * Three full frontier models — Sonnet 4.6, GPT-5, Gemini 2.5 Pro. Highest
 * cost, highest accuracy, last resort when Tier 2 splits or for AUTONOMOUS-
 * tier user requests.
 *
 * GATING: this tier MUST be explicitly enabled via opts.allow_tier3=true.
 * Default is disabled — calling tier3 without enable returns NO_PROVIDERS
 * and recommends staying at the prior tier's verdict.
 */
import { ModelSpec, providerKeyAvailable, isMockMode } from './hal-providers';
import { runTier, TierResult } from './hal-tier1-slm';

const TIER3_DEFAULT_MODELS: ModelSpec[] = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6',  display_name: 'Sonnet 4.6',
    cost_per_million_in_usd: 3.0,  cost_per_million_out_usd: 15.0 },
  { provider: 'openai',    model: 'gpt-5',              display_name: 'GPT-5',
    cost_per_million_in_usd: 5.0,  cost_per_million_out_usd: 15.0 },
  { provider: 'google',    model: 'gemini-2.5-pro',     display_name: 'Gemini 2.5 Pro',
    cost_per_million_in_usd: 1.25, cost_per_million_out_usd: 10.0 },
];

export function selectTier3Models(override?: ModelSpec[]): ModelSpec[] {
  if (override?.length) return override;
  if (isMockMode()) return TIER3_DEFAULT_MODELS;
  return TIER3_DEFAULT_MODELS.filter(m => providerKeyAvailable(m.provider));
}

export interface Tier3Options {
  models?: ModelSpec[];
  timeout_ms?: number;
  allow_tier3?: boolean; // hard gate; defaults to false
}

export async function tier3FrontierConsensus(
  query: string,
  claim: string,
  options?: Tier3Options,
): Promise<TierResult> {
  if (!options?.allow_tier3) {
    return {
      tier: 3,
      consensus: 'NO_PROVIDERS',
      responses: [],
      disagreement_count: 0,
      cost_estimate_usd: 0,
      total_latency_ms: 0,
      escalation_recommended: false,
    };
  }
  const models = selectTier3Models(options?.models);
  const timeoutMs = options?.timeout_ms ?? 15000;
  const r = await runTier(3, models, query, claim, timeoutMs);
  return r;
}
