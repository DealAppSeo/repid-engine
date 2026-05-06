import { ProviderAdapter, CompletionRequest, CompletionResponse, RateLimitError, AuthError } from './types';

export class GroqAdapter implements ProviderAdapter {
  name = 'groq';
  tier: 0 | 1 = 0;
  free = true;

  async isHealthy(): Promise<boolean> { return true; }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = req.model || 'llama-3.1-8b-instant';
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
    if (!res.ok) throw new Error(`Groq HTTP error: ${res.status}`);

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
