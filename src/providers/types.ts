export interface ProviderAdapter {
  name: string;
  tier: 0 | 1;
  free: boolean;
  isHealthy(): Promise<boolean>;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export interface CompletionRequest {
  prompt: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  apiKey: string;
  timeout?: number;
}

export interface CompletionResponse {
  answer: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  provider: string;
  model: string;
  rawResponse?: any;
}

export class RateLimitError extends Error {
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}
