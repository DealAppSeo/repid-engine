import { ProviderAdapter, CompletionRequest, CompletionResponse, RateLimitError, AuthError, providerHttpError, defaultModelFor } from './types';

export class AnthropicAdapter implements ProviderAdapter {
  name = 'anthropic';
  tier: 0 | 1 = 1;
  free = false;

  async isHealthy(): Promise<boolean> { return true; }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = req.model || defaultModelFor('anthropic', 'claude-3-5-haiku-20241022');
    const timeout = req.timeout || 30000;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': req.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: req.prompt }],
          max_tokens: req.maxTokens || 1024,
          temperature: req.temperature
        }),
        signal: controller.signal
      });
    } catch (e: any) {
      clearTimeout(id);
      throw new Error(`Anthropic fetch error: ${e.message}`);
    }
    clearTimeout(id);

    if (res.status === 401 || res.status === 403) throw new AuthError('Anthropic auth failed');
    if (res.status === 429) {
      const retry = res.headers.get('retry-after');
      const retryMs = retry ? parseInt(retry) * 1000 : 10000;
      throw new RateLimitError('Anthropic rate limited', retryMs);
    }
    if (!res.ok) throw await providerHttpError('Anthropic', res);

    const data = await res.json();
    return {
      answer: data.content?.[0]?.text || '',
      tokensIn: data.usage?.input_tokens || 0,
      tokensOut: data.usage?.output_tokens || 0,
      latencyMs: Date.now() - startTime,
      provider: this.name,
      model,
      rawResponse: data
    };
  }
}
