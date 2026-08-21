import { ProviderAdapter, CompletionRequest, CompletionResponse, RateLimitError, AuthError, providerHttpError, defaultModelFor } from './types';

export class OpenAIAdapter implements ProviderAdapter {
  name = 'openai';
  tier: 0 | 1 = 1;
  free = false;

  async isHealthy(): Promise<boolean> { return true; }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = req.model || defaultModelFor('openai', 'gpt-4o-mini');
    const timeout = req.timeout || 30000;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    let res: Response;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
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
      throw new Error(`OpenAI fetch error: ${e.message}`);
    }
    clearTimeout(id);

    if (res.status === 401 || res.status === 403) throw new AuthError('OpenAI auth failed');
    if (res.status === 429) {
      const retry = res.headers.get('retry-after');
      const retryMs = retry ? parseInt(retry) * 1000 : 10000;
      throw new RateLimitError('OpenAI rate limited', retryMs);
    }
    if (!res.ok) throw await providerHttpError('OpenAI', res);

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
