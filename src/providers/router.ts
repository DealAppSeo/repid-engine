import { ProviderAdapter, CompletionRequest, CompletionResponse, RateLimitError, AuthError } from './types';
import { GroqAdapter } from './groq';
import { GeminiAdapter } from './gemini';
import { CerebrasAdapter } from './cerebras';
import { DeepSeekAdapter } from './deepseek';
import { CohereAdapter } from './cohere';
import { AnthropicAdapter } from './anthropic';
import { OpenAIAdapter } from './openai';
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
  chosen_tier: '0a' | '1' | 'none';
  reason: 'priority_healthy' | 'fallback_after_failure' | 'tier1_required' | 'all_exhausted' | 'cap_hit';
  tried: string[];
}

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

export async function routeRequest(req: RouteRequest, excludeProviders: string[] = []): Promise<{ adapter: ProviderAdapter | null, decision: RouteDecision }> {
  const tried: string[] = [...excludeProviders];

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
