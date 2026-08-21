import { ProviderAdapter, CompletionRequest, CompletionResponse, RateLimitError, AuthError, providerHttpError, defaultModelFor } from './types';

/**
 * OpenRouter adapter — OpenAI-compatible aggregator. Idle-but-LIVE key
 * (OPENROUTER_API_KEY) wired 2026-07-07 as the LAST tier-0 fallback so a burst
 * that 429s the free tiers still has an escape hatch before escalating to
 * tier-1 (anthropic/openai). Default model is a cheap PAID variant (~$0 per
 * call) so the fallback actually resolves under load instead of 429-ing like a
 * `:free` slug; override via OPENROUTER_MODEL.
 *
 * Per OpenRouter norms it sends HTTP-Referer (from OPENROUTER_REFERRER) and an
 * X-Title header — both optional on OpenRouter's side but recommended for
 * attribution/ranking. Key is read from req.apiKey (resolved from env by the
 * router, exactly like every peer adapter) — NEVER hardcoded.
 *
 * DEAD-SLUG FIX (2026-07-08): the prior default `meta-llama/llama-3.3-70b-instruct:free` 429s hard on
 * the free tier (verified live) — self-defeating for a LAST-resort fallback whose whole job is to fire
 * when the free tiers are already throttling. Default is now the cheap PAID `qwen/qwen-2.5-72b-instruct`
 * (verified 200 + real content on the live /models list; ~$0 per call, we have OpenRouter balance).
 * Override via OPENROUTER_MODEL — verify the slug is on the live /models list before setting it.
 */
export class OpenRouterAdapter implements ProviderAdapter {
  name = 'openrouter';
  tier: 0 | 1 = 0;
  free = true;

  async isHealthy(): Promise<boolean> { return true; }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = req.model || defaultModelFor('openrouter', 'qwen/qwen-2.5-72b-instruct');
    const timeout = req.timeout || 30000;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    const headers: Record<string, string> = {
      'Authorization': `Bearer ${req.apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': process.env.OPENROUTER_TITLE || 'repid-engine',
    };
    const referrer = process.env.OPENROUTER_REFERRER?.trim();
    if (referrer) headers['HTTP-Referer'] = referrer;

    let res: Response;
    try {
      res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers,
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
      throw new Error(`OpenRouter fetch error: ${e.message}`);
    }
    clearTimeout(id);

    if (res.status === 401 || res.status === 403) throw new AuthError('OpenRouter auth failed');
    if (res.status === 429) {
      const retry = res.headers.get('retry-after');
      const retryMs = retry ? parseInt(retry) * 1000 : 10000;
      throw new RateLimitError('OpenRouter rate limited', retryMs);
    }
    if (!res.ok) throw await providerHttpError('OpenRouter', res);

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
