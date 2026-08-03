export const PRICING_PER_1M_TOKENS: Record<string, Record<string, { in: number; out: number }>> = {
  groq: {
    'llama-3.1-8b-instant': { in: 0.05, out: 0.08 },
    'llama-3.1-70b-versatile': { in: 0.59, out: 0.79 },
    'mixtral-8x7b-32768': { in: 0.24, out: 0.24 }
  },
  cerebras: {
    'llama3.1-8b': { in: 0.10, out: 0.10 },
    'llama3.1-70b': { in: 0.60, out: 0.60 },
    // FREE TIER, stated explicitly rather than left to a fallback. This is the
    // model HAL's cerebras voice actually uses (HAL_S2_CEREBRAS_MODEL default),
    // because llama3.1-8b 404s on our key — see billing/free-providers.ts.
    'zai-glm-4.7': { in: 0, out: 0 },
    'glm-4.5-flash': { in: 0, out: 0 }
  },
  // Z.AI (Zhipu) direct — GLM family on the vendor's free tier.
  zai: {
    'glm-4.5-flash': { in: 0, out: 0 },
    'glm-4.7': { in: 0, out: 0 }
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
    // AN UNPRICED MODEL COSTS "UNKNOWN", NOT "WHATEVER IS LISTED FIRST".
    //
    // This used to fall back to `providerPricing[Object.keys(...)[0]]` — the first
    // model in the provider's table. It fabricated a number that looked exactly
    // like a measurement, and the ledger had no way to say it was a guess.
    //
    // Observed 2026-08-03: cerebras `zai-glm-4.7` has no entry here, so 25,995 HAL
    // quorum calls silently inherited `llama3.1-8b`'s $0.10/1M and reported $1.44
    // — 59 % of apparent total spend, on a model that free-providers.ts explicitly
    // classifies as FREE (our cerebras key 404s on llama, so GLM is the only model
    // we can reach). That fabricated figure reached /api/v1/costs, the status
    // digest, and a written recommendation to "route away from cerebras" that was
    // wrong because of it.
    //
    // Returning 0 is not a claim the call was free. It is a refusal to invent a
    // price, paired with a loud log so the missing entry gets registered rather
    // than silently estimated forever. Same register-first discipline as
    // family-registry: unknown reports as unknown.
    console.warn(
      `[pricing] UNPRICED MODEL provider=${provider} model=${model} — cost recorded as 0. ` +
        `This is "not priced", NOT "free". Add an explicit entry (0 for a genuine free tier) ` +
        `so the cost ledger stops guessing.`,
    );
    return 0;
  }
  const costIn = (tokensIn / 1_000_000) * modelPricing.in;
  const costOut = (tokensOut / 1_000_000) * modelPricing.out;
  return Math.round((costIn + costOut) * 1_000_000) / 1_000_000;
}
