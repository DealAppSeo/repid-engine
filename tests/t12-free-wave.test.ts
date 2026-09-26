import { t12FreeWaveEnabled, t12FreeWaveOrder } from '../src/orchestration/t12-free-wave';

describe('T12_FREE_WAVE', () => {
  it('is off unless the variable is the exact string true, and never selects anthropic', () => {
    expect(t12FreeWaveEnabled({})).toBe(false);
    expect(t12FreeWaveOrder({})).toEqual([]);
    expect(t12FreeWaveEnabled({ T12_FREE_WAVE: 'TRUE' })).toBe(false);
    expect(t12FreeWaveEnabled({ T12_FREE_WAVE: '1' })).toBe(false);
    expect(t12FreeWaveOrder({ T12_FREE_WAVE: 'true' })).toEqual(['groq', 'cerebras']);
    expect(t12FreeWaveOrder({ T12_FREE_WAVE: 'true' }).join(' ')).not.toMatch(/anthropic/);
  });
});
