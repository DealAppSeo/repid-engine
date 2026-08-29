import { catalogPriceFor } from '../hal/model-catalog';

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
    // 2026-08-04: `gemini-2.0-flash` is RETIRED (HTTP 404 on every call) and the HAL
    // default moved to `gemini-2.5-flash`, which had NO row — so every call emitted
    // "UNPRICED MODEL" and ledgered at 0. Left alone that is the same shape as the
    // phantom $1.44, pointed the other way: instead of inventing a cost it hides one.
    // Priced explicitly at the published paid rate rather than 0, because 0 here would
    // assert a free tier this key has not been shown to be on.
    'gemini-2.5-flash': { in: 0.30, out: 2.50 },
    'gemini-2.5-flash-lite': { in: 0.10, out: 0.40 },
    // Retired upstream. Kept so historical rows stay costable — deleting a row would
    // silently reprice the past.
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
  // NO EARLY RETURN ON AN UNKNOWN PROVIDER, and this line is the whole point of the change.
  //
  // This used to be `if (!providerPricing) return 0;`, which meant a provider absent from the
  // static table below could never be priced at all — it returned 0 before anything else ran.
  // `openrouter` is exactly that provider: it has no row here, and it is the one carrying the
  // gateway-routed models whose spend was invisible. So the early exit skipped precisely the
  // case the catalog lookup exists to serve. Caught by a test, not by reading.
  const providerPricing = PRICING_PER_1M_TOKENS[provider];
  const modelPricing = providerPricing?.[model];
  if (!modelPricing) {
    // BEFORE GIVING UP, ASK THE VENDOR. The catalog refresh already fetches every provider's
    // `/models` every 30 minutes, and a gateway publishes a rate for each one — so the price is
    // usually sitting in memory while this table has no row for it. Consulting it turns the common
    // unpriced case (a model nobody typed a row for) into a real number, which is the whole reason
    // frontier models routed through a gateway ledgered at $0.00 against real token counts.
    //
    // The static table above still WINS when it has an entry: it is the human override, and it
    // carries deliberate assertions (a known free tier, a retired model kept so old rows stay
    // costable) that a live catalog cannot express.
    //
    // Returns null — never 0 — when the vendor published nothing, so the unpriced path below is
    // still reached and still says so out loud.
    const fromCatalog = catalogPriceFor(provider, model);
    if (fromCatalog) {
      const cIn = (tokensIn / 1_000_000) * fromCatalog.in;
      const cOut = (tokensOut / 1_000_000) * fromCatalog.out;
      return Math.round((cIn + cOut) * 1_000_000) / 1_000_000;
    }

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
        `so the cost ledger stops guessing. (The vendor catalog published no rate for it either.)`,
    );
    return 0;
  }
  const costIn = (tokensIn / 1_000_000) * modelPricing.in;
  const costOut = (tokensOut / 1_000_000) * modelPricing.out;
  return Math.round((costIn + costOut) * 1_000_000) / 1_000_000;
}
