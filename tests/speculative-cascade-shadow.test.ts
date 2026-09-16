/**
 * Speculative cascade shadow wiring (backlog item 8).
 *
 * Tests that the shadow oracle:
 *   - Is inert (returns null, logs nothing) when CASCADE_SPECULATION_ENABLED is unset or false.
 *   - Logs and returns a shadow decision when the flag is true.
 *   - Correctly maps high anfisConfidence → accept-draft, low → escalate.
 *   - Never makes real provider calls (injected stubs are synchronous).
 *   - Includes proxyWarning: true on every record.
 */
import { shadowCascadeDecision } from '../src/providers/speculative-cascade-shadow';

const BASE_INPUT = {
  anfisConfidence: 0.9,
  staticTier: '0a',
  anfisTier: '0a',
  draftEstimatedCostUsd: 0.0001,
  escalateEstimatedCostUsd: 0.003,
};

describe('shadowCascadeDecision', () => {
  let consoleSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    delete process.env['CASCADE_SPECULATION_ENABLED'];
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    delete process.env['CASCADE_SPECULATION_ENABLED'];
  });

  test('returns null and logs nothing when CASCADE_SPECULATION_ENABLED is unset', async () => {
    const result = await shadowCascadeDecision(BASE_INPUT);
    expect(result).toBeNull();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  test('returns null and logs nothing when CASCADE_SPECULATION_ENABLED=false', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'false';
    const result = await shadowCascadeDecision(BASE_INPUT);
    expect(result).toBeNull();
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  test('returns a shadow decision and logs when CASCADE_SPECULATION_ENABLED=true', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    const result = await shadowCascadeDecision(BASE_INPUT);
    expect(result).not.toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(
      '[CASCADE-SHADOW]',
      expect.stringContaining('"proxyWarning":true'),
    );
  });

  test('high anfisConfidence (above threshold) → accept draft, no escalation', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    const result = await shadowCascadeDecision({ ...BASE_INPUT, anfisConfidence: 0.95 });
    expect(result?.usedEscalation).toBe(false);
    expect(result?.proxyWarning).toBe(true);
  });

  test('low anfisConfidence (below threshold) → escalate', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    const result = await shadowCascadeDecision({ ...BASE_INPUT, anfisConfidence: 0.3 });
    expect(result?.usedEscalation).toBe(true);
    expect(result?.proxyWarning).toBe(true);
  });

  test('exact-threshold confidence (0.7) is accepted, not escalated', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    const result = await shadowCascadeDecision({ ...BASE_INPUT, anfisConfidence: 0.7 });
    expect(result?.usedEscalation).toBe(false);
  });

  test('custom confidenceThreshold overrides default', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    // anfisConfidence=0.5 normally escalates; a threshold of 0.4 should accept it
    const result = await shadowCascadeDecision({
      ...BASE_INPUT,
      anfisConfidence: 0.5,
      confidenceThreshold: 0.4,
    });
    expect(result?.usedEscalation).toBe(false);
  });

  test('log record includes anfisConfidence and tier fields', async () => {
    process.env['CASCADE_SPECULATION_ENABLED'] = 'true';
    await shadowCascadeDecision({ ...BASE_INPUT, staticTier: '0a', anfisTier: '1' });
    expect(consoleSpy).toHaveBeenCalledWith(
      '[CASCADE-SHADOW]',
      expect.stringContaining('"staticTier":"0a"'),
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      '[CASCADE-SHADOW]',
      expect.stringContaining('"anfisTier":"1"'),
    );
  });
});
