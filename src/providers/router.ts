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
            chosen_tier: 'slm',
            reason: 'slm_low_complexity',
            tried
          }
        };
      } else {
        tried.push(adapter.name);
      }
    }
  }

  const tryTier0 = req.tier_preference !== 'tier1_only';
  const tryTier1 = req.tier_preference !== 'tier0_only';

  let capHit = false;

  if (tryTier0) {
    for (const adapter of tier0aAdapters) {
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
          }
        };
      } else {
        tried.push(adapter.name);
      }
    }
  }

  if (tryTier1 && req.user_paid_keys) {
    for (const adapter of tier1Adapters) {
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
