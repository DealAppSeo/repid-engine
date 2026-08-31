/**
 * Free-tier daily call-quota tracking (backlog item 9's second half, 2026-08-31).
 *
 * Pure decision layer: no DB read here — caller supplies today's call count and a cap, exactly
 * like slm-tier.test.ts / speculative-cascade.test.ts test their neighbors with injected inputs.
 */
import { evaluateFreeTierQuota } from '../../src/billing/free-tier-quota';

describe('evaluateFreeTierQuota', () => {
  test('allows a call under the daily cap and reports remaining', () => {
    const decision = evaluateFreeTierQuota({ provider: 'groq', callsToday: 3, dailyCallCap: 10 });
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(7);
    expect(decision.reason).toContain('groq');
  });

  test('denies a call at the daily cap', () => {
    const decision = evaluateFreeTierQuota({ provider: 'cerebras', callsToday: 10, dailyCallCap: 10 });
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
    expect(decision.reason).toMatch(/quota.*reached/);
  });

  test('denies a call already over the daily cap', () => {
    const decision = evaluateFreeTierQuota({ provider: 'sambanova', callsToday: 15, dailyCallCap: 10 });
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  test('a cap of 0 or below means uncapped, not a silent deny', () => {
    const decision = evaluateFreeTierQuota({ provider: 'zai', callsToday: 999, dailyCallCap: 0 });
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(Infinity);
    expect(decision.reason).toContain('no daily call cap');
  });
});
