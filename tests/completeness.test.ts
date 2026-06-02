/**
 * S-FIX Phase 2 — HAL completeness check (offline via injected LLM).
 */
import { checkCompleteness, parseCompleteness, isCompletenessEnabled } from '../src/hal/completeness';

describe('parseCompleteness', () => {
  it('parses an integer 0-100 into 0..1', () => {
    expect(parseCompleteness('72')).toBeCloseTo(0.72, 5);
    expect(parseCompleteness('Score: 100')).toBe(1);
    expect(parseCompleteness('0')).toBe(0);
  });
  it('defaults to 0.5 when unparseable', () => {
    expect(parseCompleteness('no number here')).toBe(0.5);
    expect(parseCompleteness('')).toBe(0.5);
  });
});

describe('checkCompleteness (injected LLM)', () => {
  it('returns the LLM-rated completeness', async () => {
    const score = await checkCompleteness('What were the capitals of California?', 'Sacramento.', async () => '40');
    expect(score).toBeCloseTo(0.4, 5);
  });
  it('returns high for a complete answer', async () => {
    const score = await checkCompleteness('Capitals of California?', 'San Jose, Vallejo, Benicia, and Sacramento (and SF briefly in 1862).', async () => '95');
    expect(score).toBeCloseTo(0.95, 5);
  });
  it('never throws — neutral 0.5 on LLM failure', async () => {
    const score = await checkCompleteness('q', 'a', async () => { throw new Error('llm down'); });
    expect(score).toBe(0.5);
  });
  it('neutral on empty input', async () => {
    expect(await checkCompleteness('', 'a', async () => '10')).toBe(0.5);
  });
  it('is OFF by default (opt-in)', () => {
    const prev = process.env.HAL_COMPLETENESS;
    delete process.env.HAL_COMPLETENESS;
    expect(isCompletenessEnabled()).toBe(false);
    if (prev !== undefined) process.env.HAL_COMPLETENESS = prev;
  });
});
