import { ProviderAdapter, CompletionRequest, CompletionResponse, RateLimitError, AuthError } from './types';

export class CohereAdapter implements ProviderAdapter {
  name = 'cohere';
  tier: 0 | 1 = 0;
  free = true;

  async isHealthy(): Promise<boolean> { return true; }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = req.model || 'command-r';
    const timeout = req.timeout || 30000;

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    let res: Response;
    try {
      res = await fetch('https://api.cohere.com/v1/chat', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${req.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          message: req.prompt,
          max_tokens: req.maxTokens,
          temperature: req.temperature
        }),
        signal: controller.signal
      });
    } catch (e: any) {
      clearTimeout(id);
      throw new Error(`Cohere fetch error: ${e.message}`);
    }
    clearTimeout(id);

    if (res.status === 401 || res.status === 403) throw new AuthError('Cohere auth failed');
    if (res.status === 429) {
      const retry = res.headers.get('retry-after');
      const retryMs = retry ? parseInt(retry) * 1000 : 10000;
      throw new RateLimitError('Cohere rate limited', retryMs);
    }
    if (!res.ok) throw new Error(`Cohere HTTP error: ${res.status}`);

    const data = await res.json();
    return {
      answer: data.text || '',
      tokensIn: data.meta?.billed_units?.input_tokens || 0,
      tokensOut: data.meta?.billed_units?.output_tokens || 0,
      latencyMs: Date.now() - startTime,
      provider: this.name,
      model,
      rawResponse: data
    };
  }
}
