import { factCheck } from '../../src/hal/fact-check';

describe('HAL Local Fallback Layer', () => {
  const originalEnvFallback = process.env.HAL_LOCAL_FALLBACK_ENABLED;
  const dummyProviders = [
    { name: 'groq', endpoint: 'https://groq.test', apiKey: 'test', model: 'test' }
  ];

  afterAll(() => {
    process.env.HAL_LOCAL_FALLBACK_ENABLED = originalEnvFallback;
  });

  beforeEach(() => {
    // Mock fetch to fail to simulate total provider outage
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('falls back to local_slm when provider outage occurs and fallback is enabled', async () => {
    process.env.HAL_LOCAL_FALLBACK_ENABLED = 'true';

    const result = await factCheck('This statement contains false claims.', dummyProviders);

    expect(result.providers_used).toBe(1);
    expect(result.fallback_used).toBe('local_slm');
    expect(result.confidence).toBe('degraded');
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0].provider).toBe('local_slm');
    expect(result.verdicts[0].verdict).toBe('FALSE');
    expect(result.hal_score).toBe(0.8);
    expect(result.decision).toBe('vetoed');
  });

  it('does not fall back to local_slm and returns standard outage response when disabled', async () => {
    process.env.HAL_LOCAL_FALLBACK_ENABLED = 'false';

    const result = await factCheck('This statement is true.', dummyProviders);

    expect(result.providers_used).toBe(0);
    expect(result.fallback_used).toBeUndefined();
    expect(result.confidence).toBeUndefined();
    expect(result.decision).toBe('flagged');
    expect(result.hal_score).toBe(0.5);
  });
});
