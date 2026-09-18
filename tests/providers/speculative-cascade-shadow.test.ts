import { shadowCascadeDecision } from '../../src/providers/speculative-cascade-shadow';

const BASE_INPUT = {
  anfisConfidence: 0.8,
  staticTier: 'slm',
  anfisTier: '0a',
};

describe('shadowCascadeDecision', () => {
  beforeEach(() => {
    delete process.env['CASCADE_SPECULATION_ENABLED'];
  });

  afterEach(() => {
    delete process.env['CASCADE_SPECULATION_ENABLED'];
  });

  it('returns null when CASCADE_SPECULATION_ENABLED is not set', async () => {
    const result = await shadowCascadeDecision(BASE_INPUT);
    expect(result).toBeNull();
  });

  it('returns null when CASCADE_SPECULATION_ENABLED is "false"', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'false';
    const result = await shadowCascadeDecision(BASE_INPUT);
    expect(result).toBeNull();
  });

  it('returns a decision when CASCADE_SPECULATION_ENABLED is "true"', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    const result = await shadowCascadeDecision(BASE_INPUT);
    expect(result).not.toBeNull();
  });

  it('high anfisConfidence → usedEscalation false (draft accepted)', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    const result = await shadowCascadeDecision({ ...BASE_INPUT, anfisConfidence: 0.9 });
    expect(result).not.toBeNull();
    expect(result!.usedEscalation).toBe(false);
  });

  it('low anfisConfidence → usedEscalation true (cascade would escalate)', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    const result = await shadowCascadeDecision({ ...BASE_INPUT, anfisConfidence: 0.3 });
    expect(result).not.toBeNull();
    expect(result!.usedEscalation).toBe(true);
  });

  it('proxyWarning is always true on returned decision', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    const high = await shadowCascadeDecision({ ...BASE_INPUT, anfisConfidence: 0.95 });
    const low = await shadowCascadeDecision({ ...BASE_INPUT, anfisConfidence: 0.2 });
    expect(high!.proxyWarning).toBe(true);
    expect(low!.proxyWarning).toBe(true);
  });

  it('savedUsd is non-negative on accepted draft (cost saving over always-escalate)', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    const result = await shadowCascadeDecision({ ...BASE_INPUT, anfisConfidence: 0.95 });
    expect(result).not.toBeNull();
    expect(result!.savedUsd).toBeGreaterThanOrEqual(0);
  });

  it('custom confidenceThreshold is respected', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    // anfisConfidence=0.6 is above the default 0.7 threshold? No, 0.6 < 0.7 so would escalate.
    // But if we set threshold=0.5, then 0.6 >= 0.5 → should NOT escalate.
    const withDefault = await shadowCascadeDecision({ ...BASE_INPUT, anfisConfidence: 0.6 });
    const withLowThreshold = await shadowCascadeDecision({
      ...BASE_INPUT,
      anfisConfidence: 0.6,
      confidenceThreshold: 0.5,
    });
    expect(withDefault!.usedEscalation).toBe(true);   // 0.6 < 0.7 default → escalate
    expect(withLowThreshold!.usedEscalation).toBe(false); // 0.6 >= 0.5 custom → accept
  });

  it('never throws for any valid input', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    await expect(
      shadowCascadeDecision({ anfisConfidence: 0, staticTier: '', anfisTier: '' }),
    ).resolves.not.toThrow();
    await expect(
      shadowCascadeDecision({ anfisConfidence: 1, staticTier: 'slm', anfisTier: '1' }),
    ).resolves.not.toThrow();
  });
});
