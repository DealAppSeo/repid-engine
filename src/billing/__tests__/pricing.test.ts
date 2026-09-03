/**
 * pricing — the fabrication case is the point of this file.
 *
 * The assertion that used to sit here said an unknown model "falls back to the
 * first model" of its provider, and expected that fabricated number. That
 * behaviour was REMOVED and RETRACTED: observed 2026-08-03, 25,995 quorum calls on
 * an unlisted cerebras model silently inherited another model's rate and reported
 * $1.44 — 59% of apparent spend, on a model classified FREE — and that figure
 * reached the costs endpoint, the status digest, and a written recommendation to
 * route away from a provider, which was wrong because of it.
 *
 * So this file was asserting, as correct, the exact behaviour a published
 * retraction exists to prevent. It never failed, because this directory was not in
 * `jest.config.js` `roots`. Had it run, it would have BLOCKED the fix.
 *
 * `tests/pricing-no-fabrication.test.ts` is the thorough regression suite for the
 * refusal. What is kept here is the small, colocated arithmetic check plus the one
 * assertion the old file got backwards, now pointing the right way.
 */
import { calculateCost } from '../pricing';

describe('Pricing Calculator', () => {
  it('computes cost from the declared per-1M rates', () => {
    // 1000 in / 500 out. Both providers' rows are declared in the static table, so
    // this is arithmetic on published rates, not a lookup fallback.
    expect(calculateCost('openai', 'gpt-4o-mini', 1000, 500)).toBe(0.00045);
    expect(calculateCost('groq', 'llama-3.1-8b-instant', 1000, 500)).toBe(0.00009);
  });

  it('scales linearly in both token directions', () => {
    const one = calculateCost('openai', 'gpt-4o-mini', 1_000_000, 0);
    expect(calculateCost('openai', 'gpt-4o-mini', 2_000_000, 0)).toBeCloseTo(one * 2, 10);
    const out = calculateCost('openai', 'gpt-4o-mini', 0, 1_000_000);
    expect(out).toBeGreaterThan(one); // output is dearer than input on every real vendor
  });

  it('AN UNPRICED MODEL IS NOT PRICED AT ANOTHER MODEL\'S RATE', () => {
    // THE INVERTED ASSERTION. This line used to expect 0.00009 — llama-3.1-8b-instant's
    // price, applied to a model that has no row. Unknown must report unknown.
    const fabricated = calculateCost('groq', 'llama-3.1-8b-instant', 1000, 500);
    const unknown = calculateCost('groq', 'definitely-not-a-real-model', 1000, 500);
    expect(unknown).not.toBe(fabricated);
    expect(unknown).toBe(0);
  });

  it('an unknown provider is 0 — and reaches the unpriced path rather than exiting early', () => {
    // The early `if (!providerPricing) return 0` was removed so gateway-routed models
    // still get a catalog lookup. The observable result for a genuinely unknown
    // provider is unchanged; what changed is that the lookup now happens.
    expect(calculateCost('unknown_provider', 'model', 1000, 500)).toBe(0);
  });

  it('a declared free tier is 0 by assertion, not by failing to find a price', () => {
    // Indistinguishable in the number, entirely different in meaning — the free rows
    // exist so a $0 here is a claim someone made, not an absence.
    expect(calculateCost('cerebras', 'zai-glm-4.7', 10_000_000, 10_000_000)).toBe(0);
  });
});
