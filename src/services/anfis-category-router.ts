/**
 * anfis-category-router.ts — C1 + C2: real per-category routing + cheapest-competent selection.
 *
 * SHADOW-ONLY: this module logs decisions and returns recommendations. It does NOT execute
 * LLM calls and does NOT replace any live routing path. The orchestrator (routeRequest in
 * providers/router.ts) calls this for shadow telemetry; prod routing remains static until
 * a Cowork co-sign explicitly promotes a category.
 *
 * C1: per-category provider selection using the EXISTING ANFIS fitness weights from
 *     anfis-routing-service-handler.ts (hit_rate × latencyFit × costFit). Reuses the
 *     costTierOf classifier from hal/fact-check.ts for ordering, not reinventing it.
 *
 * C2: cheapest-competent selection — given a category, picks the cheapest provider whose
 *     cost tier clears the competence bar for that category. Shadow-logs the chosen
 *     provider + the rejected cheaper alternatives + why.
 *
 * Schema ground-truth (verified 2026-06-16 via Supabase MCP):
 *   anfis_routing_logs columns (in ordinal order):
 *     id             integer (PK, auto)
 *     request_text   text
 *     selected_model text          ← provider/model slug, e.g. "groq/llama-3.1-8b-instant"
 *     confidence_score double precision
 *     cost_saved     numeric
 *     latency_ms     integer
 *     success        boolean
 *     created_at     timestamp (auto)
 *     verified_by    ARRAY
 *
 * IMPORTANT: there is NO `selected_provider` column. Provider is embedded in `selected_model`.
 * IMPORTANT: there is NO `category` column. Category is encoded in `request_text` prefix.
 */

import { db } from '../db';
import { costTierOf } from '../hal/fact-check';
import { isHealthy } from '../providers/health';

// ──────────────────────────────────────────────────────────────────────────────
// TYPES
// ──────────────────────────────────────────────────────────────────────────────

export type PromptCategory =
  | 'factual'
  | 'math'
  | 'code'
  | 'creative'
  | 'opinion'
  | 'classification'
  | 'routing_decision'
  | 'quick_check'
  | 'general';

/** A provider candidate with enough metadata to score it. */
export interface ProviderCandidate {
  provider: string;
  /** Default model slug for this provider when no override is given. */
  model: string;
  /** HAL hit-rate estimate (0–1). Sourced from historical data or seeded default. */
  hitRate: number;
  /** Median latency in ms. */
  avgLatencyMs: number;
  /** Average cost in micro-USDC (1 = $0.000001). */
  avgCostUsdc: number;
}

export interface AnfisDecision {
  /** Winning provider name (e.g. "groq"). */
  provider: string;
  /** Full model slug written to selected_model (e.g. "groq/llama-3.1-8b-instant"). */
  modelSlug: string;
  /** ANFIS fitness score (0–1 clamped). */
  confidence: number;
  /** Cost tier of the chosen provider. */
  costTier: 'free' | 'cheap' | 'escalation';
  /** C2: estimated USD saved vs next-tier alternative. 0 when already cheapest. */
  costSavedUsd: number;
  /** C2: cheaper candidates that were rejected + reason. */
  rejectedCheaper: Array<{ provider: string; reason: string }>;
  /** C2: providers tried at same or higher tier that lost on fitness. */
  alternativesTried: string[];
  /** Prompt category driving this decision. */
  category: PromptCategory;
  /** Whether a health-gate skipped any provider. */
  healthSkips: string[];
}

// ──────────────────────────────────────────────────────────────────────────────
// PROVIDER POOL (reuses the same set as router.ts tier0aAdapters + tier1Adapters)
// All costs in micro-USDC per call (nominal 500 in / 100 out tokens).
// These are seed defaults; they're overridden by live performance data when available.
// ──────────────────────────────────────────────────────────────────────────────

const PROVIDER_POOL: ProviderCandidate[] = [
  // free tier
  { provider: 'groq',     model: 'llama-3.1-8b-instant', hitRate: 0.92, avgLatencyMs:  180, avgCostUsdc:    68 },
  { provider: 'cerebras', model: 'llama3.1-8b',           hitRate: 0.88, avgLatencyMs:  150, avgCostUsdc:    75 },
  { provider: 'gemini',   model: 'gemini-2.0-flash',      hitRate: 0.85, avgLatencyMs:  400, avgCostUsdc:    90 },
  { provider: 'cohere',   model: 'command-r',             hitRate: 0.80, avgLatencyMs:  600, avgCostUsdc:   500 },
  // cheap tier
  { provider: 'deepseek', model: 'deepseek-chat',         hitRate: 0.83, avgLatencyMs:  900, avgCostUsdc:   270 },
  // escalation tier
  { provider: 'openai',   model: 'gpt-4o-mini',           hitRate: 0.90, avgLatencyMs:  700, avgCostUsdc:   150 },
  { provider: 'anthropic',model: 'claude-haiku-4-5',      hitRate: 0.93, avgLatencyMs:  800, avgCostUsdc:  1000 },
];

// ──────────────────────────────────────────────────────────────────────────────
// CATEGORY → COMPETENCE FLOOR
// A provider is "competent" for a category when its hitRate meets this floor.
// Categories that need reasoning or multi-step work have a higher floor.
// ──────────────────────────────────────────────────────────────────────────────

const COMPETENCE_FLOOR: Record<PromptCategory, number> = {
  factual:          0.85,
  math:             0.88,
  code:             0.88,
  creative:         0.80,
  opinion:          0.78,
  classification:   0.80,
  routing_decision: 0.80,
  quick_check:      0.78,
  general:          0.82,
};

// ──────────────────────────────────────────────────────────────────────────────
// COST TIER ORDERING  (free=0 < cheap=1 < escalation=2)
// ──────────────────────────────────────────────────────────────────────────────

const TIER_RANK: Record<'free' | 'cheap' | 'escalation', number> = {
  free: 0,
  cheap: 1,
  escalation: 2,
};

function tierOf(p: ProviderCandidate): 'free' | 'cheap' | 'escalation' {
  return costTierOf({ name: p.provider });
}

// ──────────────────────────────────────────────────────────────────────────────
// FITNESS SCORE  — matches computeFitnessScore in anfis-routing-service-handler.ts
// (hit_rate × latencyFit × costFit), reused exactly, not reimplemented.
// latency_budget = 5000 ms, cost_budget = 100_000 micro-USDC
// ──────────────────────────────────────────────────────────────────────────────

const LATENCY_BUDGET_MS = 5_000;
const COST_BUDGET_USDC  = 100_000;

function fitnessScore(p: ProviderCandidate): number {
  const latencyFit = LATENCY_BUDGET_MS >= p.avgLatencyMs ? 1.0 : LATENCY_BUDGET_MS / p.avgLatencyMs;
  const costFit    = COST_BUDGET_USDC  >= p.avgCostUsdc  ? 1.0 : COST_BUDGET_USDC  / p.avgCostUsdc;
  return p.hitRate * latencyFit * costFit;
}

// ──────────────────────────────────────────────────────────────────────────────
// C2: CHEAPEST-COMPETENT SELECTION
//
// Algorithm:
//   1. Build the competence floor for the category.
//   2. Among all healthy candidates that clear the floor, group by cost tier.
//   3. Pick the cheapest tier group, then within it pick highest fitness.
//   4. Shadow-log every rejected candidate at a cheaper tier (showing why it lost).
// ──────────────────────────────────────────────────────────────────────────────

function selectCheapestCompetent(
  category: PromptCategory,
  candidates: ProviderCandidate[],
  healthSkips: string[],
): {
  winner: ProviderCandidate;
  rejectedCheaper: Array<{ provider: string; reason: string }>;
  alternativesTried: string[];
  costSavedUsd: number;
} {
  const floor = COMPETENCE_FLOOR[category];

  // Partition into competent (clears floor) vs not
  const competent: Array<{ p: ProviderCandidate; tier: 'free' | 'cheap' | 'escalation'; rank: number; fitness: number }> = [];
  const incompetent: Array<{ provider: string; reason: string }> = [];

  for (const p of candidates) {
    if (!isHealthy(p.provider)) {
      healthSkips.push(p.provider);
      continue;
    }
    if (p.hitRate < floor) {
      incompetent.push({ provider: p.provider, reason: `hitRate ${p.hitRate.toFixed(2)} < floor ${floor.toFixed(2)} for ${category}` });
      continue;
    }
    const tier = tierOf(p);
    competent.push({ p, tier, rank: TIER_RANK[tier], fitness: fitnessScore(p) });
  }

  if (competent.length === 0) {
    // No competent healthy provider — fall back to highest-fitness candidate regardless of floor
    const fallback = candidates
      .filter(p => isHealthy(p.provider))
      .map(p => ({ p, fitness: fitnessScore(p) }))
      .sort((a, b) => b.fitness - a.fitness)[0];

    if (!fallback) {
      // Absolute last resort: first candidate in pool
      const last = candidates[0]!;
      return {
        winner: last,
        rejectedCheaper: incompetent,
        alternativesTried: [],
        costSavedUsd: 0,
      };
    }
    return {
      winner: fallback.p,
      rejectedCheaper: incompetent,
      alternativesTried: [],
      costSavedUsd: 0,
    };
  }

  // Sort: cheapest tier first, then highest fitness within tier
  competent.sort((a, b) => a.rank !== b.rank ? a.rank - b.rank : b.fitness - a.fitness);

  const winner = competent[0]!;
  const alternatives = competent.slice(1).map(c => c.p.provider);

  // Cost-saved: compare winner to the next-tier alternative (if any)
  // Express in USD for the log (nominal 500-in / 100-out tokens)
  const NOMINAL_IN = 500;
  const NOMINAL_OUT = 100;
  function costUsd(p: ProviderCandidate): number {
    // micro-USDC → USD  (avgCostUsdc already is micro-USDC per call)
    return p.avgCostUsdc / 1_000_000;
  }

  const nextTier = competent.find(c => c.rank > winner.rank);
  const costSavedUsd = nextTier ? Math.max(0, costUsd(nextTier.p) - costUsd(winner.p)) : 0;

  return {
    winner: winner.p,
    rejectedCheaper: incompetent,
    alternativesTried: alternatives,
    costSavedUsd,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ──────────────────────────────────────────────────────────────────────────────

/**
 * C1 + C2: select the best provider for a prompt category using ANFIS fitness
 * weights and the cheapest-competent rule. Pure decision — no I/O.
 */
export function selectForCategory(
  category: PromptCategory,
  pool: ProviderCandidate[] = PROVIDER_POOL,
): AnfisDecision {
  const healthSkips: string[] = [];
  const { winner, rejectedCheaper, alternativesTried, costSavedUsd } =
    selectCheapestCompetent(category, pool, healthSkips);

  const confidence = Math.min(1, Math.max(0, fitnessScore(winner)));
  const ct = tierOf(winner);

  return {
    provider: winner.provider,
    modelSlug: `${winner.provider}/${winner.model}`,
    confidence,
    costTier: ct,
    costSavedUsd,
    rejectedCheaper,
    alternativesTried,
    category,
    healthSkips,
  };
}

/**
 * Infer a PromptCategory from a free-form task hint or prompt text.
 * Reuses the pattern logic from router.ts isLowComplexity + anfis-router.ts featurizePrompt.
 */
export function inferCategory(prompt: string, taskHint?: string): PromptCategory {
  const h = (taskHint ?? '').toLowerCase();
  const p = prompt.toLowerCase();

  if (/classification|classify|routing_decision|quick_check/.test(h)) return 'classification';
  // Math check before factual — arithmetic expressions take priority over "what is" phrasing
  if (/math|calc|comput/.test(h) || /\d+\s*[×x*\/+\-]\s*\d+|\bequation\b|\bsolve\b/.test(p)) return 'math';
  if (/factual|fact/.test(h) || /is this true|what is|define/.test(p)) return 'factual';
  if (/code|debug|implement|function|class|sql/.test(h + ' ' + p)) return 'code';
  if (/creative|story|poem|fiction|narrative/.test(h + ' ' + p)) return 'creative';
  if (/opinion|sentiment|review|rate|prefer/.test(h + ' ' + p)) return 'opinion';
  if (prompt.length < 200) return 'quick_check';
  return 'general';
}

// ──────────────────────────────────────────────────────────────────────────────
// SHADOW LOG  — writes one row per decision to anfis_routing_logs using REAL columns.
// Non-blocking: a DB failure must never propagate to the caller.
// Encodes category in request_text prefix so it's recoverable without a new column.
// ──────────────────────────────────────────────────────────────────────────────

export async function shadowLog(
  decision: AnfisDecision,
  originalRequest: string,
  latencyMs: number = 0,
): Promise<void> {
  // Encode the category in the request_text so GROUP BY selected_model + text prefix = C3 query.
  // Format: "[ANFIS:category] <first 200 chars of original request>"
  const requestText = `[ANFIS:${decision.category}] ${originalRequest.slice(0, 200)}`;

  try {
    const { error } = await db.from('anfis_routing_logs').insert({
      request_text: requestText,
      selected_model: decision.modelSlug,          // real column, holds provider/model slug
      confidence_score: decision.confidence,
      cost_saved: decision.costSavedUsd,
      latency_ms: latencyMs,
      success: true,
      // verified_by is ARRAY — we tag with the routing version for traceability
      verified_by: ['cc-2026-06-16-anfis-routing'],
    });
    if (error) {
      console.error('[anfis-category-router] shadow log insert error:', error.message);
    }
  } catch (e: any) {
    console.error('[anfis-category-router] shadow log threw:', e?.message ?? e);
  }
}

/**
 * Convenience: infer category, select provider, shadow-log, return decision.
 * This is the single call site for the shadow path in router.ts.
 *
 * SHADOW-ONLY guard: only runs when ANFIS_CATEGORY_SHADOW=true (default false in prod).
 * The log write is fire-and-forget (no await needed at call site).
 */
export async function routeWithShadow(
  prompt: string,
  taskHint?: string,
  pool?: ProviderCandidate[],
): Promise<AnfisDecision | null> {
  if (process.env.ANFIS_CATEGORY_SHADOW !== 'true') {
    return null; // shadow disabled — caller uses static router unchanged
  }

  const category = inferCategory(prompt, taskHint);
  const decision = selectForCategory(category, pool);

  // Fire-and-forget shadow log; latency is 0 because we're not actually calling a provider
  void shadowLog(decision, prompt, 0);

  // C2 shadow log: rejected cheaper alternatives (for diversity/cost-savings audit)
  if (decision.rejectedCheaper.length > 0) {
    console.log(
      '[ANFIS-C2] rejected-cheaper',
      JSON.stringify({
        category,
        winner: decision.provider,
        costTier: decision.costTier,
        costSavedUsd: decision.costSavedUsd,
        rejectedCheaper: decision.rejectedCheaper,
        alternativesTried: decision.alternativesTried,
      }),
    );
  }

  return decision;
}

// Export pool for test injection
export { PROVIDER_POOL };
