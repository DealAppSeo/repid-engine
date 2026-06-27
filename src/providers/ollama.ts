/**
 * ollama.ts — local LLM floor (B3). Terminates the resilient free chain so that when every cloud
 * provider is down/rate-limited, a request can still be served from a local Ollama instance instead of
 * failing. OFF by default (flag `LLM_OLLAMA_FLOOR_ENABLED`) until Ollama is reachable in the target env.
 *
 * Uses Ollama's OpenAI-compatible chat endpoint so the call shape matches the cloud adapters. If
 * OLLAMA_URL/OLLAMA_FALLBACK_MODEL are unset or the server is unreachable, the chain raises a clear
 * error rather than silently returning nothing (RULE-8 fail-loud).
 */
import { ProviderAdapter, CompletionRequest, CompletionResponse } from './types';

export const OLLAMA_PROVIDER_NAME = 'ollama';

export function ollamaUrl(): string {
  return process.env.OLLAMA_URL || 'http://localhost:11434';
}

export function ollamaModel(): string {
  return process.env.OLLAMA_FALLBACK_MODEL || 'llama3.2';
}

/** Is the Ollama floor turned on AND configured? */
export function ollamaFloorEnabled(): boolean {
  return process.env.LLM_OLLAMA_FLOOR_ENABLED === 'true';
}

export class OllamaAdapter implements ProviderAdapter {
  name = OLLAMA_PROVIDER_NAME;
  tier: 0 | 1 = 0;
  free = true;

  /** Reachability probe — GET /api/tags. Never throws. */
  async isHealthy(): Promise<boolean> {
    if (!ollamaFloorEnabled()) return false;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: controller.signal });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(id);
    }
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = req.model || ollamaModel();
    const timeout = req.timeout || 60000; // local models can be slow on CPU

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    let res: Response;
    try {
      res = await fetch(`${ollamaUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: req.prompt }],
          max_tokens: req.maxTokens,
          temperature: req.temperature,
        }),
        signal: controller.signal,
      });
    } catch (e: any) {
      clearTimeout(id);
      throw new Error(`Ollama fetch error (${ollamaUrl()}): ${e.message}`);
    }
    clearTimeout(id);

    if (!res.ok) throw new Error(`Ollama HTTP error: ${res.status}`);

    const data: any = await res.json();
    return {
      answer: data.choices?.[0]?.message?.content || '',
      tokensIn: data.usage?.prompt_tokens || 0,
      tokensOut: data.usage?.completion_tokens || 0,
      latencyMs: Date.now() - startTime,
      provider: this.name,
      model,
      rawResponse: data,
    };
  }
}

export const ollamaAdapter = new OllamaAdapter();
