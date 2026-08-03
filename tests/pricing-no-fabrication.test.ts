/**
 * The cost ledger must never invent a price.
 *
 * `calculateCost` used to fall back to `providerPricing[Object.keys(...)[0]]` when a
 * model had no entry — the FIRST model in that provider's table. It produced a
 * number indistinguishable from a measurement.
 *
 * Observed live 2026-08-03: cerebras `zai-glm-4.7` has no pricing entry, so 25,995
 * HAL quorum calls inherited `llama3.1-8b`'s $0.10/1M and reported **$1.44 — 59 % of
 * apparent total spend** — on a model `free-providers.ts` explicitly classifies as
 * FREE. That fabricated figure reached `/api/v1/costs`, the status digest, and a
 * written recommendation to "route away from cerebras" that was wrong because of it.
 *
 * The fix is a refusal, not a better guess: unknown reports as unknown, loudly, the
 * same register-first discipline family-registry uses.
 */

import { calculateCost } from '../src/billing/pricing';

describe('an unpriced model is never assigned another model\'s price', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('THE REGRESSION: an unknown cerebras model does not inherit llama3.1-8b pricing', () => {
    // llama3.1-8b is keys[0] for cerebras and costs $0.10/1M. The old fallback
    // charged every unpriced cerebras model at that rate.
    const cost = calculateCost('cerebras', 'some-model-with-no-entry', 1_000_000, 1_000_000);
    expect(cost).toBe(0);
    // Explicitly assert it is NOT the fabricated figure the fallback would produce.
    expect(cost).not.toBeCloseTo(0.2, 6);
  });

  it('says so loudly, and says "not priced" rather than "free"', () => {
    calculateCost('cerebras', 'mystery-model', 1000, 1000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('UNPRICED MODEL'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mystery-model'));
    // The distinction that stops this becoming a silent zero forever.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/NOT "free"/));
  });

  it('does not warn for a model with an explicit entry', () => {
    calculateCost('cerebras', 'llama3.1-8b', 1000, 1000);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the model that caused this is now explicitly free', () => {
  it('cerebras zai-glm-4.7 costs 0 by declaration, not by fallback', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // 10M tokens each way — a fallback rate would be very visible.
    expect(calculateCost('cerebras', 'zai-glm-4.7', 10_000_000, 10_000_000)).toBe(0);
    expect(warn).not.toHaveBeenCalled(); // declared, so no "unpriced" warning
    warn.mockRestore();
  });

  it('Z.AI direct is priced free for both GLM models', () => {
    expect(calculateCost('zai', 'glm-4.5-flash', 5_000_000, 5_000_000)).toBe(0);
    expect(calculateCost('zai', 'glm-4.7', 5_000_000, 5_000_000)).toBe(0);
  });
});

describe('genuine pricing still works', () => {
  it('prices a known paid model correctly', () => {
    // 1M in + 1M out at $0.10 each = $0.20
    expect(calculateCost('cerebras', 'llama3.1-8b', 1_000_000, 1_000_000)).toBeCloseTo(0.2, 6);
  });

  it('an entirely unknown provider is 0 without pretending otherwise', () => {
    expect(calculateCost('not-a-provider', 'not-a-model', 1_000_000, 1_000_000)).toBe(0);
  });

  it('zero tokens cost zero', () => {
    expect(calculateCost('cerebras', 'llama3.1-8b', 0, 0)).toBe(0);
  });
});
