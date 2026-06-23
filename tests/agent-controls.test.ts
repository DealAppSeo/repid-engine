import { toControlName } from '../src/services/agent-controls';

describe('agent-controls', () => {
  it('normalizes trinity- prefix for SSOT table keys', () => {
    expect(toControlName('trinity-mel')).toBe('mel');
    expect(toControlName('MEL')).toBe('mel');
    expect(toControlName('trinity-veritas')).toBe('veritas');
  });
});