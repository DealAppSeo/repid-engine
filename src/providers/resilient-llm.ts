/**
 * resilient-llm.ts — health-aware ordered free chain ending at a local Ollama floor (B3).
 *
 * Single entrypoint `resilientComplete()` that walks the working free triad
 * (groq llama-3.1-8b-instant → cerebras zai-glm-4.7 → sambanova Meta-Llama-3.1-8B-Instruct, from
 * billing/free-providers.ts WORKING_FREE_PROVIDERS; fireworks RETIRED 2026-06-04), skipping any provider the EXISTING health.ts
 * marks unhealthy, calling markRateLimit on 429 / markFailure on error / markSuccess on success, and
 * terminating at the Ollama floor (providers/ollama.ts, flag LLM_OLLAMA_FLOOR_ENABLED). If every cloud
 * provider AND the floor are down, it throws a single clear `AllLlmProvidersDown` (RULE-8 — no silent
 * empty). Publishes per-provider `SurfaceHealth` and honors an ANFIS `RoutingDecision.preferredEndpoint`
 * when the llm surface is enabled (RESILIENCE_ANFIS_ENABLE_LLM, default OFF).
 *
 * This EXTENDS the existing routing surface (it reuses providers/health.ts — it does NOT fork the
 * router). The free providers are OpenAI-compatible, so a single openai-compat caller serves all three;
 * this avoids coupling to the per-adapter classes (no fireworks adapter exists) while honoring the
 * canonical model list. The Ollama floor reuses the OllamaAdapter.
 */
import { isHealthy, markFailure, markSuccess, markRateLimit, getHealthState } from './health';
import { WORKING_FREE_PROVIDERS } from '../billing/free-providers';
import { ollamaAdapter, ollamaFloorEnabled, OLLAMA_PROVIDER_NAME } from './ollama';
import type { CompletionResponse } from './types';
import { publishHealth, getRoutingDecision, isEndpointHardDown } from '../resilience/health-bus';
import type { RoutingDecision, SurfaceHealth } from '../resilience/types';

export interface ResilientLlmRequest {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/** Thrown when every cloud provider and the local floor are unavailable (clear, non-hanging). */
export class AllLlmProvidersDown extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllLlmProvidersDown';
  }
}

/** OpenAI-compatible endpoint + env key per free provider (matches src/hal/lib/cross-llm). */
interface FreeProviderWire {
  provider: string;
  model: string;
  endpoint: string;
  apiKeyEnv: string;
}

const PROVIDER_WIRES: Record<string, { endpoint: string; apiKeyEnv: string }> = {
  groq: { endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKeyEnv: 'GROQ_API_KEY' },
  cerebras: { endpoint: 'https://api.cerebras.ai/v1/chat/completions', apiKeyEnv: 'CEREBRAS_API_KEY' },
  // sambanova (2026-07-07) — 3rd FAST free Llama family, replaces retired fireworks in the free chain.
  sambanova: { endpoint: 'https://api.sambanova.ai/v1/chat/completions', apiKeyEnv: 'SAMBANOVA_API_KEY' },
  // fireworks RETIRED 2026-06-04 (account suspended → 100% fail). Wire kept out of the chain; any
  // legacy WORKING_FREE_PROVIDERS entry naming it would resolve to no wire and be filtered out.
};

function freeChain(): FreeProviderWire[] {
  return WORKING_FREE_PROVIDERS.map((p) => {
    const wire = PROVIDER_WIRES[p.provider];
    return {
      provider: p.provider,
      model: p.model,
      endpoint: wire?.endpoint ?? '',
      apiKeyEnv: wire?.apiKeyEnv ?? '',
    };
  }).filter((p) => p.endpoint);
}

function llmSurfaceActuates(): boolean {
  return process.env.RESILIENCE_ANFIS_ENABLE_LLM === 'true';
}

function publishLlmHealth(provider: string, latencyMs: number, ok: boolean, err?: string): void {
  try {
    const state = getHealthState(provider);
    publishHealth({
      surface: 'llm',
      endpoint: provider,
      healthy: isHealthy(provider),
      // health.ts is a simple healthy/unhealthy flag; map to closed/open.
      state: isHealthy(provider) ? 'closed' : 'open',
      latencyMsEwma: latencyMs,
      errorRate: ok ? 0 : Math.min(1, state.errorCount / 3),
      lastSuccessAt: state.lastSuccessAt,
      lastError: err,
    });
  } catch {
    /* ignore */
  }
}

/** Order the free chain: ANFIS preference first (when enabled + not hard-down), else canonical order. */
function orderedChain(decision?: RoutingDecision): FreeProviderWire[] {
  const chain = freeChain();
  const eff = decision ?? (llmSurfaceActuates() ? getRoutingDecision('llm') : undefined);
  const preferred = eff?.preferredEndpoint;
  if (preferred && !isEndpointHardDown('llm', preferred)) {
    const idx = chain.findIndex((p) => p.provider === preferred);
    if (idx > 0) {
      const [p] = chain.splice(idx, 1);
      chain.unshift(p!);
    }
  }
  return chain;
}

async function callOpenAiCompat(
  wire: FreeProviderWire,
  req: ResilientLlmRequest
): Promise<CompletionResponse> {
  const apiKey = process.env[wire.apiKeyEnv]?.trim();
  if (!apiKey) throw new Error(`${wire.provider}: ${wire.apiKeyEnv} not set`);

  const startTime = Date.now();
  const timeout = req.timeoutMs || 30000;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  let res: Response;
  try {
    res = await fetch(wire.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: wire.model,
        messages: [{ role: 'user', content: req.prompt }],
        max_tokens: req.maxTokens,
        temperature: req.temperature,
      }),
      signal: controller.signal,
    });
  } catch (e: any) {
    clearTimeout(id);
    throw new Error(`${wire.provider} fetch error: ${e.message}`);
  }
  clearTimeout(id);

  if (res.status === 429) {
    const retry = res.headers.get('retry-after');
    const retryMs = retry ? parseInt(retry) * 1000 : 10000;
    const err = new Error(`${wire.provider} rate limited`) as Error & { rateLimit?: boolean; retryAfterMs?: number };
    err.rateLimit = true;
    err.retryAfterMs = retryMs;
    throw err;
  }
  if (!res.ok) throw new Error(`${wire.provider} HTTP error: ${res.status}`);

  const data: any = await res.json();
  return {
    answer: data.choices?.[0]?.message?.content || '',
    tokensIn: data.usage?.prompt_tokens || 0,
    tokensOut: data.usage?.completion_tokens || 0,
    latencyMs: Date.now() - startTime,
    provider: wire.provider,
    model: wire.model,
    rawResponse: data,
  };
}

/**
 * Resilient completion: walk the ordered free chain (health-skipping), then the Ollama floor.
 * Throws `AllLlmProvidersDown` if nothing serves.
 */
export async function resilientComplete(
  req: ResilientLlmRequest,
  decision?: RoutingDecision
): Promise<CompletionResponse> {
  const chain = orderedChain(decision);
  const tried: string[] = [];
  let lastErr: unknown;

  for (const wire of chain) {
    if (!isHealthy(wire.provider)) {
      tried.push(`${wire.provider}(unhealthy)`);
      continue;
    }
    const start = Date.now();
    try {
      const out = await callOpenAiCompat(wire, req);
      markSuccess(wire.provider);
      publishLlmHealth(wire.provider, Date.now() - start, true);
      return out;
    } catch (err: any) {
      lastErr = err;
      tried.push(wire.provider);
      if (err?.rateLimit) {
        markRateLimit(wire.provider, err.retryAfterMs || 10000);
      } else {
        markFailure(wire.provider, err instanceof Error ? err : new Error(String(err)));
      }
      publishLlmHealth(wire.provider, Date.now() - start, false, err instanceof Error ? err.message : String(err));
    }
  }

  // Local floor — only when enabled AND reachable.
  if (ollamaFloorEnabled()) {
    const start = Date.now();
    try {
      if (await ollamaAdapter.isHealthy()) {
        const out = await ollamaAdapter.complete({
          prompt: req.prompt,
          maxTokens: req.maxTokens,
          temperature: req.temperature,
          apiKey: '',
          timeout: req.timeoutMs,
        });
        publishLlmHealth(OLLAMA_PROVIDER_NAME, Date.now() - start, true);
        return out;
      }
      tried.push(`${OLLAMA_PROVIDER_NAME}(unreachable)`);
    } catch (err) {
      lastErr = err;
      tried.push(OLLAMA_PROVIDER_NAME);
      publishLlmHealth(OLLAMA_PROVIDER_NAME, Date.now() - start, false, err instanceof Error ? err.message : String(err));
    }
  }

  throw new AllLlmProvidersDown(
    `All LLM providers down (tried: ${tried.join(', ') || 'none'}). ` +
      `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'no healthy providers')}`
  );
}

/** Per-provider health snapshots for the 'llm' surface (ResilientSurface.health). */
export function llmHealth(): SurfaceHealth[] {
  const out: SurfaceHealth[] = [];
  for (const wire of freeChain()) {
    const state = getHealthState(wire.provider);
    out.push({
      surface: 'llm',
      endpoint: wire.provider,
      healthy: isHealthy(wire.provider),
      state: isHealthy(wire.provider) ? 'closed' : 'open',
      latencyMsEwma: 0,
      errorRate: Math.min(1, state.errorCount / 3),
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError?.message,
    });
  }
  if (ollamaFloorEnabled()) {
    out.push({
      surface: 'llm',
      endpoint: OLLAMA_PROVIDER_NAME,
      healthy: true,
      state: 'closed',
      latencyMsEwma: 0,
      errorRate: 0,
    });
  }
  return out;
}
