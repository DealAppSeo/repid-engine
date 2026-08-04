import { routeRequest, RouteRequest } from '../../src/providers/router';
import * as health from '../../src/providers/health';

jest.mock('../../src/billing/caps', () => ({
  checkCap: jest.fn().mockResolvedValue({ allowed: true, monthly_limit: 0, current_spent: 0, hard_disabled: false })
}));

describe('Router', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('tier0_first picks groq first', async () => {
    jest.spyOn(health, 'isHealthy').mockReturnValue(true);
    const req: RouteRequest = { prompt: 'test', tier_preference: 'tier0_first' };
    const { adapter, decision } = await routeRequest(req);
    expect(adapter?.name).toBe('groq');
    expect(decision.chosen_tier).toBe('0a');
    expect(decision.reason).toBe('priority_healthy');
  });

  /**
   * FALLBACK GOES TO THE NEXT AVAILABLE PROVIDER — not to a named one.
   *
   * This asserted `gemini` and went red on 2026-08-04 the moment a real `ZAI_API_KEY`
   * was configured, because zai sits ahead of gemini in the tier-0a chain. The
   * expectation was never about gemini; it was about "whoever is next", and it had
   * quietly hard-coded the answer for a machine with no zai key.
   *
   * Worse, the hard-coded answer encoded a DEFECT. PR #336 measured that free-first
   * does not hold: gemini is PAID and sits ahead of free providers, so a test demanding
   * "falls back to gemini" blesses reaching a paid provider while a free one is untried.
   * Asserting the SHAPE of the fallback keeps the test honest about the one thing it
   * actually owns — that a fallback happened and named what it tried — and leaves the
   * ordering question to `tests/routing-order.test.ts`, which owns it and controls its
   * own environment.
   */
  it('groq and cerebras unhealthy: falls back to the next available provider', async () => {
    jest.spyOn(health, 'isHealthy').mockImplementation(name => name !== 'groq' && name !== 'cerebras');
    const req: RouteRequest = { prompt: 'test', tier_preference: 'tier0_first' };
    const { adapter, decision } = await routeRequest(req);
    expect(decision.reason).toBe('fallback_after_failure');
    expect(decision.tried).toContain('groq');
    expect(decision.tried).toContain('cerebras');
    // Something downstream answered, and it was NOT one of the two unhealthy ones.
    expect(adapter?.name).toBeDefined();
    expect(['groq', 'cerebras']).not.toContain(adapter?.name);
  });

  it('all free exhausted falls through to tier1 if keys present', async () => {
    jest.spyOn(health, 'isHealthy').mockImplementation(name => name === 'anthropic');
    const req: RouteRequest = { 
      prompt: 'test', 
      tier_preference: 'tier0_first',
      user_paid_keys: { anthropic: 'key' }
    };
    const { adapter, decision } = await routeRequest(req);
    expect(adapter?.name).toBe('anthropic');
    expect(decision.chosen_tier).toBe('1');
    expect(decision.reason).toBe('fallback_after_failure');
  });

  it('all free exhausted returns all_exhausted if no keys', async () => {
    jest.spyOn(health, 'isHealthy').mockReturnValue(false);
    const req: RouteRequest = { prompt: 'test', tier_preference: 'tier0_first' };
    const { adapter, decision } = await routeRequest(req);
    expect(adapter).toBeNull();
    expect(decision.reason).toBe('all_exhausted');
  });

  it('tier1_only goes straight to anthropic', async () => {
    jest.spyOn(health, 'isHealthy').mockReturnValue(true);
    const req: RouteRequest = { 
      prompt: 'test', 
      tier_preference: 'tier1_only',
      user_paid_keys: { anthropic: 'key' }
    };
    const { adapter, decision } = await routeRequest(req);
    expect(adapter?.name).toBe('anthropic');
    expect(decision.reason).toBe('tier1_required');
    expect(decision.tried).toEqual([]);
  });
});
