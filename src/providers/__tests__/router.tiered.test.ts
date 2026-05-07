import { routeRequest, RouteRequest } from '../router';
import { isHealthy, markFailure, markSuccess } from '../health';

jest.mock('../health', () => ({
  isHealthy: jest.fn(),
  markFailure: jest.fn(),
  markSuccess: jest.fn(),
  markRateLimit: jest.fn()
}));

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
