import { routeRequest, RouteRequest } from '../../src/providers/router';
import * as health from '../../src/providers/health';

describe('Router', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('tier0_first picks groq first', async () => {
    jest.spyOn(health, 'isHealthy').mockReturnValue(true);
    const req: RouteRequest = { prompt: 'test', tier_preference: 'tier0_first' };
    const { adapter, decision } = await routeRequest(req);
    expect(adapter?.name).toBe('groq');
    expect(decision.chosen_tier).toBe(0);
    expect(decision.reason).toBe('priority_healthy');
  });

  it('groq unhealthy picks gemini', async () => {
    jest.spyOn(health, 'isHealthy').mockImplementation(name => name !== 'groq');
    const req: RouteRequest = { prompt: 'test', tier_preference: 'tier0_first' };
    const { adapter, decision } = await routeRequest(req);
    expect(adapter?.name).toBe('gemini');
    expect(decision.reason).toBe('fallback_after_failure');
    expect(decision.tried).toContain('groq');
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
    expect(decision.chosen_tier).toBe(1);
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
