/**
 * Free-tier provider classification for cost reporting (S-OPTIMIZE).
 *
 * The cost CALCULATOR (pricing.ts) and the per-call ledger (log-call.ts → `llm_call_log`) already
 * exist and are live. This adds the free-vs-paid lens the dashboards need, plus a "what it would
 * have cost on a frontier model" estimate for the savings metric.
 *
 * Working free set (updated 2026-07-07): groq `llama-3.1-8b-instant`, cerebras `zai-glm-4.7` (the
 * spec's `llama3.1-8b` 404s — no access on the key), and sambanova `Meta-Llama-3.1-8B-Instruct` (a
 * 3rd FAST free Llama family). Fireworks was RETIRED (account suspended 2026-06-04 → 100% fail); it
 * is kept in the FREE_PROVIDERS cost-classification set for historical ledger rows but is NOT routed
 * to. `together` IS configured (TOGETHER_API_KEY live) and counts as a free provider for cost
 * reporting, but has no adapter here yet — it is NOT in the routed WORKING set.
 */
export const FREE_PROVIDERS = new Set<string>([
  'groq', 'groq-llama', 'cerebras', 'sambanova', 'openrouter', 'fireworks', 'together', 'local_slm',
]);

/** Providers we actually have working free-tier keys for AND a routed adapter (route peer_verify across these). */
export const WORKING_FREE_PROVIDERS: { provider: string; model: string }[] = [
  { provider: 'groq', model: 'llama-3.1-8b-instant' },
  { provider: 'cerebras', model: 'zai-glm-4.7' },
  // fireworks RETIRED 2026-06-04 (account suspended → 100% fail); replaced by sambanova below.
  { provider: 'sambanova', model: 'Meta-Llama-3.1-8B-Instruct' },
];

export function isFreeProvider(provider: string | null | undefined): boolean {
  return FREE_PROVIDERS.has((provider ?? '').toLowerCase());
}

/**
 * Estimate what a call would have cost on a paid frontier model (claude-sonnet-4-6 list price),
 * for the "cost saved by routing to free tier" metric.
 */
export function frontierCostEstimate(promptTokens: number, completionTokens: number): number {
  const inRate = 3.0 / 1_000_000;  // claude-sonnet-4-6 input  $/token
  const outRate = 15.0 / 1_000_000; // claude-sonnet-4-6 output $/token
  return (promptTokens || 0) * inRate + (completionTokens || 0) * outRate;
}
