/**
 * Opt-in Mistral BFT family slot. Default OFF. Does not autobackfill.
 * Default model is the dated medium checkpoint (no Large-4 id on vendor /v1/models).
 */
import { buildFactCheckProviders, MISTRAL_LARGE_MODEL_DEFAULT, mistralLargeModel, mistralSmallModel } from '../src/hal/fact-check';

beforeEach(() => {
  delete process.env.HAL_S2_ENABLE_MISTRAL_LARGE;
  delete process.env.HAL_S2_ENABLE_MISTRAL;
  delete process.env.HAL_QUORUM_AUTOBACKFILL;
  delete process.env.MISTRAL_API_KEY;
  delete process.env.HAL_S2_MISTRAL_LARGE_MODEL;
  delete process.env.HAL_S2_MISTRAL_MODEL;
});

describe('Mistral BFT family slot', () => {
  it('does not add mistral-large when flag unset even if key present', () => {
    process.env.MISTRAL_API_KEY = 'k';
    process.env.HAL_QUORUM_AUTOBACKFILL = 'false';
    process.env.HAL_S2_ENABLE_MISTRAL = 'false';
    const providers = buildFactCheckProviders();
    expect(providers.some((p) => p.name === 'mistral-large')).toBe(false);
  });

  it('adds mistral-large with family mistral and dated default when flag is the string true', () => {
    process.env.MISTRAL_API_KEY = 'k';
    process.env.HAL_S2_ENABLE_MISTRAL_LARGE = 'true';
    process.env.HAL_QUORUM_AUTOBACKFILL = 'false';
    const providers = buildFactCheckProviders();
    const large = providers.find((p) => p.name === 'mistral-large');
    expect(large).toBeDefined();
    expect(large?.family).toBe('mistral');
    expect(large?.model).toBe(MISTRAL_LARGE_MODEL_DEFAULT);
    expect(MISTRAL_LARGE_MODEL_DEFAULT).toBe('mistral-medium-2604');
    expect(mistralLargeModel()).toBe('mistral-medium-2604');
    expect(mistralSmallModel()).toBe('mistral-small-latest');
    expect(providers.some((p) => p.name === 'mistral')).toBe(false);
  });

  it('HAL_S2_MISTRAL_LARGE_MODEL overrides the dated default', () => {
    process.env.MISTRAL_API_KEY = 'k';
    process.env.HAL_S2_ENABLE_MISTRAL_LARGE = 'true';
    process.env.HAL_QUORUM_AUTOBACKFILL = 'false';
    process.env.HAL_S2_MISTRAL_LARGE_MODEL = 'mistral-medium-3.5';
    const providers = buildFactCheckProviders();
    const large = providers.find((p) => p.name === 'mistral-large');
    expect(large?.model).toBe('mistral-medium-3.5');
    expect(mistralLargeModel()).toBe('mistral-medium-3.5');
  });
});
