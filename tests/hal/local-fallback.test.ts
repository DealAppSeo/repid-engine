import { factCheck } from '../../src/hal/fact-check';

/**
 * THE PROPERTY: a veto requires independent agreement. Nothing else may issue one.
 *
 * `factCheck` has a RESILIENCE GATE — a veto/flag needs >= MIN_QUORUM_FOR_VETO (2)
 * successful providers, or the decision downgrades. The local_slm fallback branch
 * RETURNED BEFORE that gate, so with ZERO providers responding it could still emit
 * `decision: 'vetoed'`, built from `deliverable.includes('false')`. A substring
 * match, carrying the same decision value a real cross-LLM quorum produces, and
 * therefore indistinguishable to every downstream consumer.
 *
 * MEASURED (docs/HAL-ACCURACY-2026-08-16.md): 59 corpus rows have an empty
 * hal_providers_used and 41 of those also set hal_vetoed. Dropping those vetoes
 * moves realized F1 0.8812 -> 0.8760, still 98.37% of the achievable bound — so
 * the accuracy cost is ~0.005 F1 and the gain is a veto that means what it says.
 *
 * Two assertions in the previous version of this file PINNED the defect —
 * `providers_used === 1` and `decision === 'vetoed'`, both with fetch mocked to
 * reject every request. They are inverted below, deliberately.
 */

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

    expect(result.fallback_used).toBe('local_slm');
    expect(result.confidence).toBe('degraded');
    expect(result.degraded).toBe(true);
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0].provider).toBe('local_slm');
    expect(result.verdicts[0].verdict).toBe('FALSE');
    // The heuristic's opinion is preserved — only the DECISION is gated, exactly
    // as the resilience gate preserves hal_score on the normal path.
    expect(result.hal_score).toBe(0.8);
  });

  // ─────────────────────────────────────────────── THE PROPERTY
  it('CANNOT veto with zero providers — caps at flagged', async () => {
    process.env.HAL_LOCAL_FALLBACK_ENABLED = 'true';

    const result = await factCheck('This statement contains false claims.', dummyProviders);

    expect(result.decision).toBe('flagged');
    expect(result.decision).not.toBe('vetoed');
    expect(result.quorum_note).toMatch(/capped at 'flagged'/);
  });

  it('reports providers_used = 0, because zero providers responded', async () => {
    process.env.HAL_LOCAL_FALLBACK_ENABLED = 'true';

    const result = await factCheck('This statement contains false claims.', dummyProviders);

    expect(result.providers_used).toBe(0);
    // It used to say 1 while the field beside it said 0 — one row, two
    // contradicting answers to "did a provider run?".
    expect(result.provider_health?.succeeded).toBe(0);
    expect(result.providers_used).toBe(result.provider_health?.succeeded);
  });

  it('reports agreement = null, since there was nobody to agree with', async () => {
    process.env.HAL_LOCAL_FALLBACK_ENABLED = 'true';

    const result = await factCheck('This statement contains false claims.', dummyProviders);

    // 1.0 read as unanimous consensus in precisely the case with zero sources.
    expect(result.agreement).toBeNull();
  });

  it('a benign deliverable still lands clean, so the cap is not a blanket downgrade', async () => {
    process.env.HAL_LOCAL_FALLBACK_ENABLED = 'true';

    const result = await factCheck('This statement is accurate and verified.', dummyProviders);

    expect(result.verdicts[0].verdict).toBe('TRUE');
    expect(result.hal_score).toBe(0.2);
    expect(result.decision).toBe('clean');
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

  // The two zero-provider branches disagreed on severity for the same condition:
  // fallback ON could veto, fallback OFF flagged. Same evidence, same input,
  // different verdict depending on an env var.
  it('both zero-provider branches now agree that a veto is impossible', async () => {
    process.env.HAL_LOCAL_FALLBACK_ENABLED = 'true';
    const withFallback = await factCheck('This statement contains false claims.', dummyProviders);
    process.env.HAL_LOCAL_FALLBACK_ENABLED = 'false';
    const withoutFallback = await factCheck('This statement contains false claims.', dummyProviders);

    expect(withFallback.decision).not.toBe('vetoed');
    expect(withoutFallback.decision).not.toBe('vetoed');
    expect(withFallback.providers_used).toBe(0);
    expect(withoutFallback.providers_used).toBe(0);
  });
});
