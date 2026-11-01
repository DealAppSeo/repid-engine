/**
 * Free-token circuit breaker (overnight plan 2026-11-01, item 0).
 *
 * The property under test: a loop that is meant to run on FREE tokens can never spend
 * money, and never "recovers" from free-tier exhaustion by falling back to a paid model.
 * Every refusal names a reason; an unknown price is NOT_CHECKED, never free.
 */
import { FreeTokenBreaker } from '../src/providers/free-token-breaker';

// Model-level explicit zero prices in src/billing/pricing.ts.
const FREE = { provider: 'zai', model: 'glm-4.5-flash' };
const FREE_2 = { provider: 'cerebras', model: 'zai-glm-4.7' };

describe('FreeTokenBreaker.admit — before the call', () => {
  it('admits a model with an explicit zero price', () => {
    expect(new FreeTokenBreaker().admit(FREE.provider, FREE.model)).toEqual({ decision: 'ALLOW' });
  });

  it('refuses a paid model, and offers no fallback', () => {
    const v = new FreeTokenBreaker().admit('openai', 'gpt-4o-mini');
    expect(v.decision).toBe('DENY');
    expect(v).not.toHaveProperty('fallback');
    if (v.decision !== 'ALLOW') expect(v.reason).toMatch(/paid/);
  });

  it('refuses an unpriced model as NOT_CHECKED, never as free', () => {
    const v = new FreeTokenBreaker().admit('zai', 'some-model-nobody-priced');
    expect(v.decision).toBe('NOT_CHECKED');
    if (v.decision !== 'ALLOW') expect(v.reason).toMatch(/unpriced/);
  });

  it('refuses a missing provider or model as NOT_CHECKED', () => {
    const b = new FreeTokenBreaker();
    expect(b.admit('', FREE.model).decision).toBe('NOT_CHECKED');
    expect(b.admit(FREE.provider, undefined as unknown as string).decision).toBe('NOT_CHECKED');
  });

  it('a provider-level free-tier label does not make an unpriced model free', () => {
    // groq is in FREE_PROVIDERS (a dashboard label); the model is not priced at zero.
    expect(new FreeTokenBreaker().admit('groq', 'not-a-real-groq-model').decision).not.toBe('ALLOW');
  });
});

describe('FreeTokenBreaker.record — after the call', () => {
  it('a free call that billed money halts: the receipt outranks the price table', () => {
    const b = new FreeTokenBreaker();
    const v = b.record({ ...FREE, status: 'ok', cost_usd: 0.0001 });
    expect(v.decision).toBe('DENY');
    if (v.decision !== 'ALLOW') expect(v.reason).toMatch(/billed/);
  });

  it('a missing or invalid cost halts as NOT_CHECKED', () => {
    expect(new FreeTokenBreaker().record({ ...FREE, status: 'ok' } as never).decision).toBe('NOT_CHECKED');
    expect(new FreeTokenBreaker().record({ ...FREE, status: 'ok', cost_usd: NaN }).decision).toBe('NOT_CHECKED');
    expect(new FreeTokenBreaker().record({ ...FREE, status: 'ok', cost_usd: -1 }).decision).toBe('NOT_CHECKED');
  });

  it('halts after N consecutive quota refusals, across providers: exhaustion is a stop, not a reroute', () => {
    const b = new FreeTokenBreaker({ maxConsecutiveQuota: 3 });
    expect(b.record({ ...FREE, status: 'quota', cost_usd: 0 }).decision).toBe('ALLOW');
    expect(b.record({ ...FREE_2, status: 'quota', cost_usd: 0 }).decision).toBe('ALLOW');
    const v = b.record({ ...FREE, status: 'quota', cost_usd: 0 });
    expect(v.decision).toBe('DENY');
    if (v.decision !== 'ALLOW') expect(v.reason).toMatch(/quota/);
  });

  it('a success between quota refusals resets the quota streak', () => {
    const b = new FreeTokenBreaker({ maxConsecutiveQuota: 2 });
    b.record({ ...FREE, status: 'quota', cost_usd: 0 });
    b.record({ ...FREE, status: 'ok', cost_usd: 0 });
    expect(b.record({ ...FREE, status: 'quota', cost_usd: 0 }).decision).toBe('ALLOW');
  });

  it('halts at the call cap', () => {
    const b = new FreeTokenBreaker({ maxCalls: 2 });
    expect(b.record({ ...FREE, status: 'ok', cost_usd: 0 }).decision).toBe('ALLOW');
    const v = b.record({ ...FREE, status: 'ok', cost_usd: 0 });
    expect(v.decision).toBe('DENY');
    if (v.decision !== 'ALLOW') expect(v.reason).toMatch(/cap/);
  });

  it('a recorded call to a paid model halts even if admit was skipped', () => {
    expect(new FreeTokenBreaker().record({ provider: 'openai', model: 'gpt-4o-mini', status: 'ok', cost_usd: 0 }).decision).toBe('DENY');
  });
});

describe('FreeTokenBreaker latches', () => {
  it('once tripped, admit and record keep refusing — including free calls', () => {
    const b = new FreeTokenBreaker();
    b.admit('openai', 'gpt-4o-mini');
    expect(b.tripped).not.toBeNull();
    expect(b.admit(FREE.provider, FREE.model).decision).toBe('DENY');
    expect(b.record({ ...FREE, status: 'ok', cost_usd: 0 }).decision).toBe('DENY');
  });

  it('a NOT_CHECKED trip is reported as NOT_CHECKED on later calls, not upgraded to a plain deny', () => {
    const b = new FreeTokenBreaker();
    b.admit('zai', 'unpriced-model');
    expect(b.admit(FREE.provider, FREE.model).decision).toBe('NOT_CHECKED');
  });

  it('rejects nonsense thresholds at construction', () => {
    expect(() => new FreeTokenBreaker({ maxCalls: 0 })).toThrow();
    expect(() => new FreeTokenBreaker({ maxConsecutiveQuota: 1.5 })).toThrow();
  });
});
