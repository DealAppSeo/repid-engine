import { ProviderAdapter, CompletionRequest, CompletionResponse, RateLimitError, AuthError } from './types';

export class Llama321bAdapter implements ProviderAdapter {
  name = 'llama-3-2-1b';
  tier: 0 | 1 = 0;
  free = true;

  async isHealthy(): Promise<boolean> {
    return !!(process.env.HUGGINGFACE_API_TOKEN || process.env.HF_API_KEY || process.env.HF_TOKEN);
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const token = req.apiKey || process.env.HUGGINGFACE_API_TOKEN || process.env.HF_API_KEY || process.env.HF_TOKEN || '';
    if (!token) {
      throw new AuthError('HuggingFace API token missing');
    }

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), req.timeout || 30000);

    try {
      const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta-llama/Llama-3.2-1B-Instruct',
          messages: [{ role: 'user', content: req.prompt }],
          max_tokens: req.maxTokens || 512,
          temperature: req.temperature || 0.2
        }),
        signal: controller.signal
      });

      clearTimeout(id);

      if (res.status === 401 || res.status === 403) throw new AuthError('HuggingFace auth failed');
      if (res.status === 429) throw new RateLimitError('HuggingFace rate limited', 10000);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HuggingFace HTTP ${res.status}: ${body}`);
      }

      const data: any = await res.json();
      return {
        answer: data.choices?.[0]?.message?.content || '',
        tokensIn: data.usage?.prompt_tokens || 0,
        tokensOut: data.usage?.completion_tokens || 0,
        latencyMs: Date.now() - startTime,
        provider: this.name,
        model: 'Llama-3.2-1B-Instruct',
        rawResponse: data
      };
    } catch (err: any) {
      clearTimeout(id);
      throw err;
    }
  }
}

export class Gemma32bAdapter implements ProviderAdapter {
  name = 'gemma-3-2b';
  tier: 0 | 1 = 0;
  free = true;

  async isHealthy(): Promise<boolean> {
    return !!(process.env.HUGGINGFACE_API_TOKEN || process.env.HF_API_KEY || process.env.HF_TOKEN);
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const token = req.apiKey || process.env.HUGGINGFACE_API_TOKEN || process.env.HF_API_KEY || process.env.HF_TOKEN || '';
    if (!token) {
      throw new AuthError('HuggingFace API token missing');
    }

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), req.timeout || 30000);

    try {
      // Direct call to router.huggingface.co
      const res = await fetch('https://router.huggingface.co/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'google/gemma-2-2b-it',
          messages: [{ role: 'user', content: req.prompt }],
          max_tokens: req.maxTokens || 512,
          temperature: req.temperature || 0.2
        }),
        signal: controller.signal
      });

      clearTimeout(id);

      if (res.status === 401 || res.status === 403) throw new AuthError('HuggingFace auth failed');
      if (res.status === 429) throw new RateLimitError('HuggingFace rate limited', 10000);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HuggingFace HTTP ${res.status}: ${body}`);
      }

      const data: any = await res.json();
      return {
        answer: data.choices?.[0]?.message?.content || '',
        tokensIn: data.usage?.prompt_tokens || 0,
        tokensOut: data.usage?.completion_tokens || 0,
        latencyMs: Date.now() - startTime,
        provider: this.name,
        model: 'gemma-2-2b-it',
        rawResponse: data
      };
    } catch (err: any) {
      clearTimeout(id);
      throw err;
    }
  }
}

export class Phi4Adapter implements ProviderAdapter {
  name = 'phi-4';
  tier: 0 | 1 = 0;
  free = true;

  async isHealthy(): Promise<boolean> {
    return !!process.env.CEREBRAS_API_KEY;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const key = req.apiKey || process.env.CEREBRAS_API_KEY || '';
    if (!key) {
      throw new AuthError('Cerebras API key missing');
    }

    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), req.timeout || 30000);

    try {
      const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'microsoft/Phi-4',
          messages: [{ role: 'user', content: req.prompt }],
          max_completion_tokens: req.maxTokens || 512,
          temperature: req.temperature || 0.2
        }),
        signal: controller.signal
      });

      clearTimeout(id);

      if (res.status === 401 || res.status === 403) throw new AuthError('Cerebras auth failed');
      if (res.status === 429) throw new RateLimitError('Cerebras rate limited', 10000);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Cerebras HTTP ${res.status}: ${body}`);
      }

      const data: any = await res.json();
      return {
        answer: data.choices?.[0]?.message?.content || '',
        tokensIn: data.usage?.prompt_tokens || 0,
        tokensOut: data.usage?.completion_tokens || 0,
        latencyMs: Date.now() - startTime,
        provider: this.name,
        model: 'phi-4',
        rawResponse: data
      };
    } catch (err: any) {
      clearTimeout(id);
      throw err;
    }
  }
}
