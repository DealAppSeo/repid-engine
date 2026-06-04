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
  anfis_recommended?: string | null; // SHADOW: the adapter ANFIS would have chosen (not steering when strict)
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

// R5/2026-06-04 — the ANFIS RPC aggregates repid_score_events.llm_provider (ANSWER-generation
// provider names like 'deepinfra'/'anthropic'/'gpt-4o-mini'), which never matched the router's
// tier0a/tier1 adapter names (groq/cerebras/gemini/cohere/deepseek/anthropic/openai) → findIndex=-1
// → ANFIS reorder was a silent no-op. Normalize to an adapter name (or null if none maps).
const ROUTER_ADAPTERS = ['groq', 'cerebras', 'gemini', 'cohere', 'deepseek', 'anthropic', 'openai'];
export function normalizeToAdapter(provider: string): string | null {
  const p = (provider || '').toLowerCase();
  if (ROUTER_ADAPTERS.includes(p)) return p;
  if (/cerebras|glm|zai/.test(p)) return 'cerebras'; // cerebras before the llama fallback (cerebras can host llama)
  if (/groq|llama/.test(p)) return 'groq';           // groq is the default free llama adapter
  if (/gemini|gemma|google/.test(p)) return 'gemini';
  if (/cohere|command/.test(p)) return 'cohere';
  if (/deepseek/.test(p)) return 'deepseek';
  if (/claude|anthropic/.test(p)) return 'anthropic';
  if (/gpt|openai|^o[0-9]/.test(p)) return 'openai';
  return null; // deepinfra/together/litellm/test-model etc. have no router adapter
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
    // Return the highest-scoring provider that maps to a real router adapter (skip unmappable ones).
    for (const s of scored) { const a = normalizeToAdapter(s.provider); if (a) return a; }
    return null;
  } catch (e) {
    console.error('[anfis-routing] lookup failed, falling back:', e);
    return null;
  }
}

export async function routeRequest(req: RouteRequest, excludeProviders: string[] = []): Promise<{ adapter: ProviderAdapter | null, decision: RouteDecision }> {
  const tried: string[] = [...excludeProviders];

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
          }
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
  // SHADOW MODE (2026-06-04): compute the ANFIS recommendation for LOGGING/scoring even when strict
  // cost-order is ON, but only let it REORDER production when strict cost-order is OFF. So ANFIS runs
  // in shadow (we record what it WOULD pick in decision.anfis_recommended) without steering traffic.
  const shadowLog = process.env.ANFIS_SHADOW_LOG !== 'false';
  let anfisRecommended: string | null = null;
  if ((shadowLog || !strictCostOrder) && req.tier_preference === 'auto') {
    anfisRecommended = await getAnfisRecommendation(req.task_hint || 'general');
  }
  const anfisSteers = !strictCostOrder ? anfisRecommended : null; // only reorders when NOT strict

  const tryTier0 = req.tier_preference !== 'tier1_only';
  const tryTier1 = req.tier_preference !== 'tier0_only';

  let capHit = false;

  if (tryTier0) {
    // Prioritize ANFIS recommendation in Tier 0a if applicable
    let prioritizedTier0 = [...tier0aAdapters];
    if (anfisSteers) {
      const recIndex = prioritizedTier0.findIndex(a => a.name === anfisSteers);
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
            tried,
            anfis_recommended: anfisRecommended
          }
        };
      } else {
        tried.push(adapter.name);
      }
    }
  }

  if (tryTier1 && req.user_paid_keys) {
    // Prioritize ANFIS recommendation in Tier 1 if applicable
    let prioritizedTier1 = [...tier1Adapters];
    if (anfisSteers) {
      const recIndex = prioritizedTier1.findIndex(a => a.name === anfisSteers);
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
            tried,
            anfis_recommended: anfisRecommended
          }
        };
      } else {
        tried.push(adapter.name);
      }
    }
  }

  return {
    adapter: null,
    decision: {
      chosen_provider: 'none',
      chosen_tier: 'none',
      reason: 'all_exhausted',
      tried
    }
  };
}
