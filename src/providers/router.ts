import { ProviderAdapter, CompletionRequest, CompletionResponse, RateLimitError, AuthError } from './types';
import { GroqAdapter } from './groq';
import { GeminiAdapter } from './gemini';
import { CerebrasAdapter } from './cerebras';
import { DeepSeekAdapter } from './deepseek';
import { CohereAdapter } from './cohere';
import { AnthropicAdapter } from './anthropic';
import { OpenAIAdapter } from './openai';
import { isHealthy, markFailure, markSuccess, markRateLimit } from './health';

export interface RouteRequest {
  prompt: string;
  tier_preference: 'tier0_only' | 'tier1_only' | 'tier0_first' | 'auto';
  user_paid_keys?: { openai?: string; anthropic?: string };
  task_hint?: 'chat' | 'reasoning' | 'classification' | 'creative';
  maxTokens?: number;
  temperature?: number;
}

export interface RouteDecision {
  chosen_provider: string;
  chosen_tier: 0 | 1;
  reason: 'priority_healthy' | 'fallback_after_failure' | 'tier1_required' | 'all_exhausted';
  tried: string[];
}

const tier0Adapters: ProviderAdapter[] = [
  new GroqAdapter(),
  new GeminiAdapter(),
  new CerebrasAdapter(),
  new DeepSeekAdapter(),
  new CohereAdapter()
];

const tier1Adapters: ProviderAdapter[] = [
  new AnthropicAdapter(),
  new OpenAIAdapter()
];

export async function routeRequest(req: RouteRequest, excludeProviders: string[] = []): Promise<{ adapter: ProviderAdapter | null, decision: RouteDecision }> {
  const tried: string[] = [...excludeProviders];

  const tryTier0 = req.tier_preference !== 'tier1_only';
  const tryTier1 = req.tier_preference !== 'tier0_only';

  if (tryTier0) {
    for (const adapter of tier0Adapters) {
      if (excludeProviders.includes(adapter.name)) continue;
      
      if (isHealthy(adapter.name)) {
        return {
          adapter,
          decision: {
            chosen_provider: adapter.name,
            chosen_tier: 0,
            reason: tried.length === 0 ? 'priority_healthy' : 'fallback_after_failure',
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
        return {
          adapter,
          decision: {
            chosen_provider: adapter.name,
            chosen_tier: 1,
            reason: (req.tier_preference === 'tier1_only' || req.tier_preference === 'auto' && !tryTier0) ? 'tier1_required' : 'fallback_after_failure',
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
      chosen_tier: 0,
      reason: 'all_exhausted',
      tried
    }
  };
}
