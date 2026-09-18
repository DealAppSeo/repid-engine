import { scoreOutputConfidence } from '../../src/providers/output-confidence-scorer';

describe('scoreOutputConfidence', () => {
  it('returns low confidence for a very short response', () => {
    const result = scoreOutputConfidence('Yes.');
    expect(result.confidence).toBeLessThan(0.45);
    expect(result.factors['length_very_short']).toBeDefined();
  });

  it('returns lower confidence when uncertainty markers are present', () => {
    const confident = scoreOutputConfidence(
      'The value is 42.5% based on Q3 2026 results published by Anthropic in their transparency report. ' +
        'This figure was confirmed across three independent datasets.',
    );
    const uncertain = scoreOutputConfidence(
      "I'm not sure, but it might be around 42%. I'm uncertain about the exact figure. " +
        "It's hard to say without more data. Possibly it could vary significantly.",
    );
    expect(uncertain.confidence).toBeLessThan(confident.confidence);
    expect(uncertain.factors['uncertainty_markers']).toBeDefined();
  });

  it('returns high confidence for a factually dense, non-hedged response', () => {
    const result = scoreOutputConfidence(
      'On 2026-09-15, Anthropic released Claude 5 with a 200k context window. ' +
        'The model scored 94.3% on MATH and 89.7% on HumanEval benchmarks. ' +
        'Google DeepMind confirmed similar results in their independent evaluation.',
    );
    expect(result.confidence).toBeGreaterThan(0.65);
  });

  it('returns minimum confidence (0.05) for a refusal response', () => {
    const result = scoreOutputConfidence(
      "I'm sorry, I cannot help with that request.",
    );
    expect(result.confidence).toBe(0.05);
    expect(result.factors['refusal']).toBeDefined();
  });

  it('handles empty string without throwing', () => {
    expect(() => scoreOutputConfidence('')).not.toThrow();
    const result = scoreOutputConfidence('');
    expect(result.confidence).toBe(0.05);
  });

  it('clamps confidence to [0.05, 0.95] regardless of input', () => {
    const veryLong = 'This is a highly confident, factual statement. '.repeat(100);
    const result = scoreOutputConfidence(veryLong);
    expect(result.confidence).toBeGreaterThanOrEqual(0.05);
    expect(result.confidence).toBeLessThanOrEqual(0.95);
  });

  it('accepts optional opts without affecting determinism', () => {
    const text = 'The RepID scoring system uses a 200-point floor and 10000-point cap.';
    const r1 = scoreOutputConfidence(text, { provider: 'groq', eventType: 'STAKE' });
    const r2 = scoreOutputConfidence(text);
    expect(r1.confidence).toBe(r2.confidence);
  });
});
