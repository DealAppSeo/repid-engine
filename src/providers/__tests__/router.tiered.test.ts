/**
 * A UNIT TEST THAT WAS SILENTLY MAKING NETWORK CALLS.
 *
 * `routeRequest` → `selectRoute` → `checkCap(provider)` → a live Supabase SELECT on
 * `llm_provider_caps`, once per provider considered. Nothing here mocked the database,
 * so every case in this file opened real connections and then died on jest's 5s
 * timeout — three of the five, every run.
 *
 * The failure mode matters more than the slowness: `checkCap` fails OPEN, returning
 * `{allowed: true}` on any error. So this suite's verdict depended on WHERE it ran —
 * green wherever the DB answered quickly (including with wrong data), red where it
 * hung. A routing test that passes or fails on network conditions is measuring the
 * network. This was invisible because the directory was not in jest `roots`.
 *
 * The cap lookup is mocked to "no cap configured", which is exactly what `checkCap`
 * returns for a provider with no row — the state these tier-preference cases assume.
 */
import { routeRequest, RouteRequest } from '../router';
import { isHealthy, markFailure, markSuccess } from '../health';

jest.mock('../health', () => ({
  isHealthy: jest.fn(),
  markFailure: jest.fn(),
  markSuccess: jest.fn(),
  markRateLimit: jest.fn()
}));

jest.mock('../../db', () => {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    update: () => chain,
    single: async () => ({ data: null, error: { message: 'no cap row (mocked)' } }),
  };
  return { db: { from: () => chain } };
});

describe('Tiered Router (Direct Only)', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('auto picks tier0a first (groq healthy)', async () => {
    (isHealthy as jest.Mock).mockReturnValue(true);
    
    const req: RouteRequest = { prompt: 'test', tier_preference: 'auto' };
    const { adapter, decision } = await routeRequest(req);
    
    expect(adapter?.name).toBe('groq');
    expect(decision.chosen_tier).toBe('0a');
  });

  it('All tier0a unhealthy + tier1 keys -> tier1 (anthropic)', async () => {
    (isHealthy as jest.Mock).mockImplementation((name) => {
      if (['groq', 'cerebras', 'gemini', 'cohere', 'deepseek'].includes(name)) return false;
      return true;
    });

    const req: RouteRequest = { 
      prompt: 'test', 
      tier_preference: 'auto',
      user_paid_keys: { anthropic: 'key' }
    };
    
    const { adapter, decision } = await routeRequest(req);
    
    expect(adapter?.name).toBe('anthropic');
    expect(decision.chosen_tier).toBe('1');
  });

  it('All exhausted -> 503 equivalent', async () => {
    (isHealthy as jest.Mock).mockReturnValue(false);

    const req: RouteRequest = { 
      prompt: 'test', 
      tier_preference: 'auto',
      user_paid_keys: { anthropic: 'key' }
    };
    
    const { adapter, decision } = await routeRequest(req);
    
    expect(adapter).toBeNull();
    expect(decision.reason).toBe('all_exhausted');
  });

  it('tier1_only with no keys -> error/exhausted', async () => {
    (isHealthy as jest.Mock).mockReturnValue(true);

    const req: RouteRequest = { 
      prompt: 'test', 
      tier_preference: 'tier1_only'
    };
    
    const { adapter, decision } = await routeRequest(req);
    
    expect(adapter).toBeNull();
    expect(decision.reason).toBe('all_exhausted');
  });

  it('tier0_only refuses tier1 even when 0a fails', async () => {
    (isHealthy as jest.Mock).mockImplementation((name) => {
      if (['groq', 'cerebras', 'gemini', 'cohere', 'deepseek'].includes(name)) return false;
      return true;
    });

    const req: RouteRequest = { 
      prompt: 'test', 
      tier_preference: 'tier0_only',
      user_paid_keys: { anthropic: 'key' }
    };
    
    const { adapter, decision } = await routeRequest(req);
    
    expect(adapter).toBeNull();
    expect(decision.reason).toBe('all_exhausted');
  });
});
