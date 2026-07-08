import { ProviderAdapter, CompletionRequest, CompletionResponse, RateLimitError, AuthError } from './types';

/**
 * SambaNova adapter — OpenAI-compatible, serves fast Llama models on their free
 * tier. Idle-but-LIVE key (SAMBANOVA_API_KEY) wired 2026-07-07 as a 3rd FAST
 * free family in the resilient-llm free chain + router tier-0a, so a burst that
 * 429s groq/cerebras has another free (Llama-family) fallback before paid tiers.
 *
 * Default model overridable via SAMBANOVA_MODEL. Key is read from req.apiKey
 * (resolved from env by the router, like every peer adapter) — NEVER hardcoded.
 */
export class SambaNovaAdapter implements ProviderAdapter {
  name = 'sambanova';
  tier: 0 | 1 = 0;
  free = true;

  async isHealthy(): Promise<boolean> { return true; }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = req.model || process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.1-8B-Instruct';
    const timeout = req.timeout || 30000;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    let res: Response;
    try {
      res = await fetch('https://api.sambanova.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${req.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: req.prompt }],
          max_tokens: req.maxTokens,
          temperature: req.temperature
        }),
        signal: controller.signal
      });
    } catch (e: any) {
      clearTimeout(id);
      throw new Error(`SambaNova fetch error: ${e.message}`);
    }
    clearTimeout(id);

    if (res.status === 401 || res.status === 403) throw new AuthError('SambaNova auth failed');
    if (res.status === 429) {
      const retry = res.headers.get('retry-after');
      const retryMs = retry ? parseInt(retry) * 1000 : 10000;
      throw new RateLimitError('SambaNova rate limited', retryMs);
    }
    if (!res.ok) throw new Error(`SambaNova HTTP error: ${res.status}`);

    const data = await res.json();
    return {
      answer: data.choices?.[0]?.message?.content || '',
      tokensIn: data.usage?.prompt_tokens || 0,
      tokensOut: data.usage?.completion_tokens || 0,
      latencyMs: Date.now() - startTime,
      provider: this.name,
      model,
      rawResponse: data
    };
  }
}
