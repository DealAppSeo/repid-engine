import { ProviderAdapter, CompletionRequest, CompletionResponse, RateLimitError, AuthError } from './types';
import { GroqAdapter } from './groq';
import { GeminiAdapter } from './gemini';
import { CerebrasAdapter } from './cerebras';
import { DeepSeekAdapter } from './deepseek';
import { CohereAdapter } from './cohere';
import { AnthropicAdapter } from './anthropic';
import { OpenAIAdapter } from './openai';
import { Llama321bAdapter, Gemma32bAdapter, Phi4Adapter } from './slm';
import { isHealthy, markFailure, markSuccess, markRateLimit } from './health';
import { checkCap } from '../billing/caps';
import { db } from '../db';
import { computeShadowDecision, anfisRecommendProvider } from '../services/anfis-router'; // A2 shadow for TRACK A (ANFIS/LASSO rebuild)

export interface RouteRequest {
  prompt: string;
  tier_preference: 'tier0_only' | 'tier0_first' | 'tier1_only' | 'auto';
  user_paid_keys?: { openai?: string; anthropic?: string };
  task_hint?: string;
  model_override?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface RouteDecision {
  chosen_provider: string;
  chosen_tier: '0a' | '1' | 'none' | 'slm';
  reason: 'priority_healthy' | 'fallback_after_failure' | 'tier1_required' | 'all_exhausted' | 'cap_hit' | 'slm_low_complexity';
  tried: string[];
}

const slmAdapters: ProviderAdapter[] = [
  new Llama321bAdapter(),
  new Gemma32bAdapter(),
  new Phi4Adapter()
];

const tier0aAdapters: ProviderAdapter[] = [
  new GroqAdapter(),
  new CerebrasAdapter(),
  new GeminiAdapter(),
  new CohereAdapter(),
  new DeepSeekAdapter()
];

const tier1Adapters: ProviderAdapter[] = [
  new AnthropicAdapter(),
  new OpenAIAdapter()
];

export function isLowComplexity(prompt: string, taskHint?: string): boolean {
  const p = prompt.toLowerCase();
  
  // 1. Task hint indicates low complexity
  const lowComplexityHints = ['classification', 'routing_decision', 'quick_check', 'factual', 'simple', 'short', 'hal_classify'];
  if (taskHint && lowComplexityHints.some(h => taskHint.toLowerCase().includes(h))) {
    return true;
  }
  
  // 2. Length check: very short prompts
  if (prompt.length < 200) {
    return true;
  }
  
  // 3. Keywords indicating simple tasks
  const keywords = [
    'classify', 'categorize', 'yes/no', 'yes or no', 'true/false', 'true or false', 
    'is this', 'simple factual', 'quick fact-check', 'one-word', 'short response'
  ];
  if (keywords.some(kw => p.includes(kw))) {
    return true;
  }
  
  return false;
}

/**
 * Map a caller task hint to a task_domain the performance-lookup RPC actually has rows for.
 * The RPC keys on `repid_score_events.task_domain`; the live populated domains (30d) are
 * EVERGREEN, peer_verify, cait, system, review, heal. A hint that already names one of those is
 * used verbatim; anything unknown/absent (including the legacy 'general') maps to a configurable
 * populated default so ANFIS gets a real reliability signal instead of an empty set.
 * Pure + deterministic for the same env. Reversible via ROUTER_ANFIS_DEFAULT_DOMAIN.
 */
export const ANFIS_POPULATED_DOMAINS = ['EVERGREEN', 'peer_verify', 'cait', 'system', 'review', 'heal'] as const;

export function resolveAnfisDomain(taskHint?: string): string {
  const fallback = process.env.ROUTER_ANFIS_DEFAULT_DOMAIN || 'peer_verify';
  if (!taskHint) return fallback;
  const hint = taskHint.trim();
  // Exact (case-insensitive) match against a domain that has data.
  const exact = ANFIS_POPULATED_DOMAINS.find(d => d.toLowerCase() === hint.toLowerCase());
  if (exact) return exact;
  // An explicit 'general' (the old empty default) is treated as "no useful hint".
  if (hint.toLowerCase() === 'general' || hint.length === 0) return fallback;
  // Otherwise honor the caller's hint verbatim (it may be a real, less-common domain like
  // 'research'/'finance'); the RPC returns empty for it and ANFIS falls back gracefully.
  return hint;
}

async function getAnfisRecommendation(domain: string): Promise<string | null> {
  try {
    const { data, error } = await db.rpc('anfis_provider_performance_lookup', {
      p_domain: domain,
      p_window_days: 30
    });
    if (error || !data || data.length === 0) return null;
    
    // Scored using fitness function: hit_rate * latencyFit * costFit
    // latency_budget = 5000ms, cost_budget = 100000 micro-USDC ($0.10)
    const scored = data.map((p: any) => {
      const avgLatency = Number(p.avg_latency_ms) || 1000;
      const avgCost = Number(p.avg_cost_usdc) || 1000;
      const hitRate = p.hit_rate !== null ? Number(p.hit_rate) : 0.8;
      
      const latencyFit = 5000 >= avgLatency ? 1.0 : 5000 / avgLatency;
      const costFit = 100000 >= avgCost ? 1.0 : 100000 / avgCost;
      
      return {
        provider: p.provider,
        score: hitRate * latencyFit * costFit
      };
    });
    
    scored.sort((a: any, b: any) => b.score - a.score);
    return scored[0]?.provider || null;
  } catch (e) {
    console.error('[anfis-routing] lookup failed, falling back:', e);
    return null;
  }
}

export async function routeRequest(req: RouteRequest, excludeProviders: string[] = []): Promise<{
  adapter: ProviderAdapter | null;
  decision: RouteDecision;
  staticProvider: string;
  staticTier: string;
  anfisProvider: string;
  anfisTier: string;
  anfisConfidence: number;
}> {
  const tried: string[] = [...excludeProviders];

  // 1. Compute ANFIS choice
  const anfisRec = anfisRecommendProvider(req.prompt, req.task_hint);
  const anfisProvider = anfisRec.recommendedProvider;
  const anfisTier = anfisRec.recommendedTier;
  const anfisConfidence = anfisRec.confidence;

  // 2. Compute Static choice
  let staticProvider = 'none';
  let staticTier = 'none';
  let foundStatic = false;

  // Check SLM for low complexity in static mode
  if (req.tier_preference === 'auto' && isLowComplexity(req.prompt, req.task_hint)) {
    for (const adapter of slmAdapters) {
      if (!excludeProviders.includes(adapter.name) && isHealthy(adapter.name)) {
        const cap = await checkCap(adapter.name);
        if (cap.allowed) {
          staticProvider = adapter.name;
          staticTier = 'slm';
          foundStatic = true;
          break;
        }
      }
    }
  }

  // Check Tier 0a in static mode
  if (!foundStatic && req.tier_preference !== 'tier1_only') {
    for (const adapter of tier0aAdapters) {
      if (!excludeProviders.includes(adapter.name) && isHealthy(adapter.name)) {
        const cap = await checkCap(adapter.name);
        if (cap.allowed) {
          staticProvider = adapter.name;
          staticTier = '0a';
          foundStatic = true;
          break;
        }
      }
    }
  }

  // Check Tier 1 in static mode
  if (!foundStatic && req.tier_preference !== 'tier0_only' && req.user_paid_keys) {
    for (const adapter of tier1Adapters) {
      const key = (req.user_paid_keys as any)[adapter.name];
      if (key && !excludeProviders.includes(adapter.name) && isHealthy(adapter.name)) {
        const cap = await checkCap(adapter.name);
        if (cap.allowed) {
          staticProvider = adapter.name;
          staticTier = '1';
          foundStatic = true;
          break;
        }
      }
    }
  }

  // TRACK A A2 SHADOW: always compute ANFIS rec alongside static (ANFIS does NOT decide yet).
  // Log both + outcome later (to anfis_routing_logs after schema apply).
  // Reversible: controlled by ROUTER_ANFIS_SHADOW (default on for sprint).
  let shadow: any = null;
  try {
    if (process.env.ROUTER_ANFIS_SHADOW !== 'false') {
      const staticStub = { chosen_provider: staticProvider, chosen_tier: staticTier as any, reason: 'static', tried: [] as string[] };
      shadow = computeShadowDecision(staticStub as any, req.prompt, req.task_hint);
      // For now console (table insert after migration apply + tolerant db)
      console.log('[ANFIS-SHADOW]', JSON.stringify(shadow));
    }
  } catch (e) {
    // tolerant for no key / no table yet
  }

  // Intercept for low-complexity SLM routing
  if (req.tier_preference === 'auto' && isLowComplexity(req.prompt, req.task_hint)) {
    for (const adapter of slmAdapters) {
      if (excludeProviders.includes(adapter.name)) continue;

      if (await adapter.isHealthy()) {
        const cap = await checkCap(adapter.name);
        if (!cap.allowed) {
          excludeProviders.push(adapter.name);
          tried.push(adapter.name);
          continue;
        }

        return {
          adapter,
          decision: {
            chosen_provider: adapter.name,
            chosen_tier: '0a',
            reason: 'slm_low_complexity',
            tried
          },
          staticProvider,
          staticTier,
          anfisProvider,
          anfisTier,
          anfisConfidence
        };
      } else {
        tried.push(adapter.name);
      }
    }
  }

  // ANFIS recommendation lookup
  // R6 — STRICT cost-order: tier0a is already cost-sorted (free → cheap-paid; tier1 = escalation).
  // By default we enforce that order and do NOT let ANFIS reorder it (ANFIS optimizes latency/quality,
  // not cost, and currently drives 0 traffic — routing_decisions=0). Set ROUTER_STRICT_COST_ORDER=false
  // to restore ANFIS reordering. Reversible.
  const strictCostOrder = process.env.ROUTER_STRICT_COST_ORDER !== 'false';
  let anfisRecommended: string | null = null;
  if (!strictCostOrder && req.tier_preference === 'auto') {
    // ROOT-CAUSE #4 fix (GA 2026-06-26): the performance-lookup RPC filters
    // `repid_score_events.task_domain = p_domain`. The old default `'general'` matches almost
    // nothing (387 rows / 37 with a provider over 30d, verified live), so ANFIS always saw an
    // empty signal and fell back to static — i.e. ANFIS was structurally starved even when
    // ROUTER_STRICT_COST_ORDER=false. The real, populated domains are EVERGREEN / peer_verify /
    // cait / review / system / heal. Use the caller's hint when present; otherwise fall back to a
    // configurable POPULATED default (ROUTER_ANFIS_DEFAULT_DOMAIN, default 'peer_verify' — the
    // dominant real domain, 73k rows) instead of the empty 'general'.
    const domain = resolveAnfisDomain(req.task_hint);
    anfisRecommended = await getAnfisRecommendation(domain);
  }

  const tryTier0 = req.tier_preference !== 'tier1_only';
  const tryTier1 = req.tier_preference !== 'tier0_only';

  let capHit = false;

  if (tryTier0) {
    // Prioritize ANFIS recommendation in Tier 0a if applicable
    let prioritizedTier0 = [...tier0aAdapters];
    if (anfisRecommended) {
      const recIndex = prioritizedTier0.findIndex(a => a.name === anfisRecommended);
      if (recIndex > -1) {
        const [recAdapter] = prioritizedTier0.splice(recIndex, 1);
        prioritizedTier0.unshift(recAdapter!);
      }
    }

    for (const adapter of prioritizedTier0) {
      if (excludeProviders.includes(adapter.name)) continue;
      
      if (isHealthy(adapter.name)) {
        const cap = await checkCap(adapter.name);
        if (!cap.allowed) {
          markFailure(adapter.name, new Error('Cap hit'));
          excludeProviders.push(adapter.name);
          tried.push(adapter.name);
          capHit = true;
          continue;
        }

        return {
          adapter,
          decision: {
            chosen_provider: adapter.name,
            chosen_tier: '0a',
            reason: tried.length === 0 ? 'priority_healthy' : (capHit ? 'cap_hit' : 'fallback_after_failure'),
            tried
          },
          staticProvider,
          staticTier,
          anfisProvider,
          anfisTier,
          anfisConfidence
        };
      } else {
        tried.push(adapter.name);
      }
    }
  }

  if (tryTier1 && req.user_paid_keys) {
    // Prioritize ANFIS recommendation in Tier 1 if applicable
    let prioritizedTier1 = [...tier1Adapters];
    if (anfisRecommended) {
      const recIndex = prioritizedTier1.findIndex(a => a.name === anfisRecommended);
      if (recIndex > -1) {
        const [recAdapter] = prioritizedTier1.splice(recIndex, 1);
        prioritizedTier1.unshift(recAdapter!);
      }
    }

    for (const adapter of prioritizedTier1) {
      if (excludeProviders.includes(adapter.name)) continue;

      const key = (req.user_paid_keys as any)[adapter.name];
      if (!key) continue;

      if (isHealthy(adapter.name)) {
        const cap = await checkCap(adapter.name);
        if (!cap.allowed) {
          markFailure(adapter.name, new Error('Cap hit'));
          excludeProviders.push(adapter.name);
          tried.push(adapter.name);
          capHit = true;
          continue;
        }

        return {
          adapter,
          decision: {
            chosen_provider: adapter.name,
            chosen_tier: '1',
            reason: (req.tier_preference === 'tier1_only' || !tryTier0) ? 'tier1_required' : (capHit ? 'cap_hit' : 'fallback_after_failure'),
            tried
          },
          staticProvider,
          staticTier,
          anfisProvider,
          anfisTier,
          anfisConfidence
        };
      } else {
        tried.push(adapter.name);
      }
    }
  }

  const finalDecision = {
    adapter: null,
    decision: {
      chosen_provider: 'none',
      chosen_tier: 'none' as const,
      reason: 'all_exhausted' as const,
      tried
    },
    staticProvider,
    staticTier,
    anfisProvider,
    anfisTier,
    anfisConfidence
  };
  if (shadow) {
    console.log('[ANFIS-SHADOW final]', JSON.stringify({ static: finalDecision.decision, anfis: shadow.anfis, delta: shadow.delta }));
  }
  return finalDecision;
}
