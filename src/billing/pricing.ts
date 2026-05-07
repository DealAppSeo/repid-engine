export const PRICING_PER_1M_TOKENS: Record<string, Record<string, { in: number; out: number }>> = {
  groq: {
    'llama-3.1-8b-instant': { in: 0.05, out: 0.08 },
    'llama-3.1-70b-versatile': { in: 0.59, out: 0.79 },
    'mixtral-8x7b-32768': { in: 0.24, out: 0.24 }
  },
  cerebras: {
    'llama3.1-8b': { in: 0.10, out: 0.10 },
    'llama3.1-70b': { in: 0.60, out: 0.60 }
  },
  gemini: {
    'gemini-2.0-flash': { in: 0.075, out: 0.30 },
    'gemini-1.5-flash': { in: 0.075, out: 0.30 },
    'gemini-1.5-pro': { in: 1.25, out: 5.00 }
  },
  cohere: {
    'command-r': { in: 0.50, out: 1.50 },
    'command-r-plus': { in: 2.50, out: 10.00 }
  },
  deepseek: {
    'deepseek-chat': { in: 0.27, out: 1.10 },
    'deepseek-reasoner': { in: 0.55, out: 2.19 }
  },
  anthropic: {
    'claude-haiku-4-5': { in: 1.00, out: 5.00 },
    'claude-sonnet-4-6': { in: 3.00, out: 15.00 },
    'claude-opus-4-7': { in: 15.00, out: 75.00 }
  },
  openai: {
    'gpt-4o-mini': { in: 0.15, out: 0.60 },
    'gpt-4o': { in: 2.50, out: 10.00 }
  }
};

export function calculateCost(provider: string, model: string, tokensIn: number, tokensOut: number): number {
  const providerPricing = PRICING_PER_1M_TOKENS[provider];
  if (!providerPricing) return 0;
  let modelPricing = providerPricing[model];
  if (!modelPricing) {
    const keys = Object.keys(providerPricing);
    if (keys.length > 0) {
      modelPricing = providerPricing[keys[0] as string];
    }
  }
  if (!modelPricing) return 0;
  const costIn = (tokensIn / 1_000_000) * modelPricing.in;
  const costOut = (tokensOut / 1_000_000) * modelPricing.out;
  return Math.round((costIn + costOut) * 1_000_000) / 1_000_000;
}
