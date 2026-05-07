import { calculateCost } from '../pricing';

describe('Pricing Calculator', () => {
  it('calculates cost correctly for 1000 in / 500 out across 3 providers', () => {
    // OpenAI gpt-4o-mini: 0.15/1M in, 0.60/1M out
    expect(calculateCost('openai', 'gpt-4o-mini', 1000, 500)).toBe(0.00045);

    // Groq llama-3.1-8b-instant: 0.05/1M in, 0.08/1M out
    expect(calculateCost('groq', 'llama-3.1-8b-instant', 1000, 500)).toBe(0.00009);

    // Unknown model falls back to first model
    expect(calculateCost('groq', 'unknown', 1000, 500)).toBe(0.00009);

    // Unknown provider returns 0
    expect(calculateCost('unknown_provider', 'model', 1000, 500)).toBe(0);
  });
});
