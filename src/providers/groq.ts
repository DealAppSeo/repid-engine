import { ProviderAdapter, CompletionRequest, CompletionResponse, RateLimitError, AuthError, providerHttpError, defaultModelFor } from './types';

export class GroqAdapter implements ProviderAdapter {
  name = 'groq';
  tier: 0 | 1 = 0;
  free = true;

  async isHealthy(): Promise<boolean> { return true; }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    // WAS `llama-3.1-8b-instant`. Groq announced its deprecation on 2026-06-17 and
    // SHUT IT DOWN on 2026-08-16, along with `llama-3.3-70b-versatile`. Every Groq
    // call in this system has 404'd `model_not_found` since — matching the shutdown
    // date exactly in `llm_call_log` — which is what took the free tier down and
    // produced a user-facing "Free tier exhausted" that was not true.
    //
    // `openai/gpt-oss-20b` is Groq's own documented replacement recommendation.
    //
    // SOURCED FROM VENDOR DOCS, **NOT LIVE-VERIFIED** — no Groq credential exists in
    // the environment this was written in, so no call was made to confirm the id.
    // That is NOT_CHECKED, not MEASURED. If it is wrong, the failure is loud and
    // identical to the one it replaces, and `GROQ_MODEL` overrides it without a
    // deploy. A live success row in `llm_call_log` is the only thing that promotes
    // this to MEASURED.
    const model = req.model || defaultModelFor('groq', 'openai/gpt-oss-20b');
    const timeout = req.timeout || 30000;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    let res: Response;
    try {
      res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
      throw new Error(`Groq fetch error: ${e.message}`);
    }
    clearTimeout(id);

    if (res.status === 401 || res.status === 403) throw new AuthError('Groq auth failed');
    if (res.status === 429) {
      const retry = res.headers.get('retry-after');
      const retryMs = retry ? parseInt(retry) * 1000 : 10000;
      throw new RateLimitError('Groq rate limited', retryMs);
    }
    if (!res.ok) throw await providerHttpError('Groq', res);

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
