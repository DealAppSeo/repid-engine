/**
 * cost-class.ts — ONE answer to "is this provider call free, paid, or simply unpriced?"
 *
 * WHY THIS EXISTS
 * ---------------
 * Today the codebase carries THREE independent free-vs-paid classifications and they
 * disagree with each other:
 *
 *   1. `ProviderAdapter.free` (src/providers/types.ts:4) — declared on every adapter.
 *      It is `true` on gemini / cohere / deepseek, all of which are priced at real
 *      non-zero rates in pricing.ts. In practice this field means "tier === 0", not
 *      "costs nothing", and NOTHING in the routing path ever reads it. Verified by
 *      `git grep '\.free\b'`: zero consumers. It is dead metadata that reads like a
 *      routing input.
 *
 *   2. `FREE_PROVIDERS` (src/billing/free-providers.ts:15) — a provider-level set used
 *      by the cost dashboards (routes/costs.ts, routes/efficiency.ts). It is
 *      provider-granular, so it cannot express "this provider is free on THIS model
 *      and paid on that one" — which is exactly the cerebras situation.
 *
 *   3. `PRICING_PER_1M_TOKENS` (src/billing/pricing.ts:1) — the only model-granular
 *      source, and the only one the cost ledger actually spends against.
 *
 * THE DISTINCTION THAT COST $1.44
 * -------------------------------
 * `calculateCost()` returns 0 for a model with no pricing entry. Zero is NOT a claim
 * that the call was free — it is a refusal to invent a price (see the comment at
 * pricing.ts:50). Collapsing "unpriced" into "free" is how a fabricated number reached
 * /api/v1/costs once already, in the other direction. So this module returns THREE
 * states, never two:
 *
 *   'free'     — an EXPLICIT pricing entry of { in: 0, out: 0 }. Someone asserted it.
 *   'paid'     — an explicit entry with a non-zero rate.
 *   'unpriced' — no entry. We do not know. Not free, not paid, NOT ZERO — unknown.
 *
 * Same register-first discipline as decisioning/family-registry: unknown reports as
 * unknown rather than defaulting to the convenient answer.
 *
 * INERT. Pure functions over two constant tables. No I/O, no env reads, no routing
 * effect. Nothing in this file changes which provider serves a request.
 */

import { FREE_PROVIDERS } from '../billing/free-providers';
import { PRICING_PER_1M_TOKENS } from '../billing/pricing';

export type CostClass = 'free' | 'paid' | 'unpriced';

/**
 * The model each adapter falls back to when the caller does not name one — i.e. the
 * model that ACTUALLY gets billed on a default request. Each entry cites the line it
 * mirrors; tests/routing-cost-class.test.ts reads those source files and fails if a
 * default drifts away from this table, so the duplication cannot rot silently.
 */
export const ADAPTER_DEFAULT_MODELS: Record<string, string> = {
  groq: 'llama-3.1-8b-instant', // src/providers/groq.ts:12
  cerebras: 'llama3.1-8b', // src/providers/cerebras.ts:12
  zai: 'glm-4.5-flash', // src/providers/zai.ts:43 (DEFAULT_MODEL)
  sambanova: 'Meta-Llama-3.1-8B-Instruct', // src/providers/sambanova.ts:21
  gemini: 'gemini-1.5-flash', // src/providers/gemini.ts:12
  cohere: 'command-r', // src/providers/cohere.ts:12
  deepseek: 'deepseek-chat', // src/providers/deepseek.ts:12
  openrouter: 'qwen/qwen-2.5-72b-instruct', // src/providers/openrouter.ts:31
  anthropic: 'claude-3-5-haiku-20241022', // src/providers/anthropic.ts:12
  openai: 'gpt-4o-mini', // src/providers/openai.ts:12
};

/**
 * Cost class for an explicit (provider, model) pair.
 *
 * An absent provider table OR an absent model within a present table both yield
 * 'unpriced' — the two are the same epistemic state ("no one has told us the price")
 * and must not be conflated with a rate of zero.
 */
export function costClass(provider: string, model: string): CostClass {
  const table = PRICING_PER_1M_TOKENS[(provider ?? '').toLowerCase()];
  if (!table) return 'unpriced';
  const entry = table[model];
  if (!entry) return 'unpriced';
  return entry.in === 0 && entry.out === 0 ? 'free' : 'paid';
}

/**
 * Cost class for a provider on the model it would actually use by default.
 * This is the class that matters for routing order: the router picks a PROVIDER, and
 * the provider then picks its default model.
 */
export function defaultCostClass(provider: string): CostClass {
  const model = ADAPTER_DEFAULT_MODELS[provider];
  if (!model) return 'unpriced';
  return costClass(provider, model);
}

/** What the dashboards' provider-level set claims. Kept separate — it is a DIFFERENT claim. */
export function declaredFree(provider: string): boolean {
  return FREE_PROVIDERS.has((provider ?? '').toLowerCase());
}

/**
 * Is this provider safe to treat as costing nothing on a default request?
 *
 * ONLY an explicit zero-rate entry qualifies. 'unpriced' deliberately returns false:
 * a provider we have no price for may well be billing us, and the whole point of the
 * three-state class is to stop "we didn't measure it" from being read as "it's free".
 */
export function isConfirmedFree(provider: string): boolean {
  return defaultCostClass(provider) === 'free';
}

/**
 * The OPERATIONAL cost class — the lens the router and the cost dashboards actually run on.
 *
 * Neither source alone is sufficient. `FREE_PROVIDERS` records which vendors we hold a
 * FREE-TIER entitlement with; `PRICING_PER_1M_TOKENS` records LIST prices. Those answer
 * different questions, which is why groq is simultaneously "free" (we are on its free
 * tier) and "$0.05/1M" (its list rate) — and why neither table is wrong, only unlabelled.
 *
 * For routing order the entitlement is what matters: a call to a provider we are
 * free-tiered with costs nothing regardless of its list price. So a declared free-tier
 * entitlement wins, and everything else falls back to the pricing table — where an
 * absent entry still reports 'unpriced', never 'free'.
 */
export function operationalCostClass(provider: string): CostClass {
  if (declaredFree(provider)) return 'free';
  return defaultCostClass(provider);
}

export interface CostClassDisagreement {
  provider: string;
  defaultModel: string | null;
  /** ProviderAdapter.free as declared on the adapter class (caller supplies; see router). */
  adapterFree?: boolean;
  /** Membership in billing/free-providers.ts FREE_PROVIDERS. */
  inFreeProvidersSet: boolean;
  /** Class derived from the pricing table on the default model. */
  pricingClass: CostClass;
  reason: string;
}

/**
 * Enumerate every provider where the classification sources disagree.
 *
 * This is a DIAGNOSTIC, not a gate — it returns findings and changes nothing. It exists
 * so the disagreement is a queryable list instead of tribal knowledge, and so a test can
 * pin the current set and fail loudly when someone adds a fourth contradiction.
 *
 * @param adapterFreeFlags optional map of provider → ProviderAdapter.free, so the third
 *        source can be folded in without this module importing the adapter classes.
 */
export function costClassDisagreements(
  adapterFreeFlags: Record<string, boolean> = {},
): CostClassDisagreement[] {
  const out: CostClassDisagreement[] = [];
  const providers = new Set([
    ...Object.keys(ADAPTER_DEFAULT_MODELS),
    ...Object.keys(adapterFreeFlags),
  ]);

  for (const provider of [...providers].sort()) {
    const defaultModel = ADAPTER_DEFAULT_MODELS[provider] ?? null;
    const pricingClass = defaultCostClass(provider);
    const inSet = declaredFree(provider);
    const adapterFree = adapterFreeFlags[provider];

    const reasons: string[] = [];
    if (inSet && pricingClass === 'paid') {
      reasons.push(
        `FREE_PROVIDERS says free but the default model '${defaultModel}' is priced non-zero`,
      );
    }
    if (!inSet && pricingClass === 'free') {
      reasons.push(
        `priced at zero but absent from FREE_PROVIDERS, so cost dashboards count it as paid`,
      );
    }
    if (inSet && pricingClass === 'unpriced') {
      reasons.push(
        `FREE_PROVIDERS says free but no pricing entry exists — that is UNPRICED, not free`,
      );
    }
    if (adapterFree === true && pricingClass === 'paid') {
      reasons.push(`adapter declares free = true but the default model is priced non-zero`);
    }
    if (adapterFree === false && pricingClass === 'free') {
      reasons.push(`adapter declares free = false but the default model is priced at zero`);
    }

    if (reasons.length > 0) {
      const d: CostClassDisagreement = {
        provider,
        defaultModel,
        inFreeProvidersSet: inSet,
        pricingClass,
        reason: reasons.join('; '),
      };
      if (adapterFree !== undefined) d.adapterFree = adapterFree;
      out.push(d);
    }
  }
  return out;
}
