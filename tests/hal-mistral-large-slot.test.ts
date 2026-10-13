/**
 * Mistral-Large-4 BFT family slot. Default OFF. Does not autobackfill.
 */
import { buildFactCheckProviders } from '../src/hal/fact-check';

beforeEach(() => {
  delete process.env.HAL_S2_ENABLE_MISTRAL_LARGE;
  delete process.env.HAL_S2_ENABLE_MISTRAL;
  delete process.env.HAL_QUORUM_AUTOBACKFILL;
  delete process.env.MISTRAL_API_KEY;
  delete process.env.HAL_S2_MISTRAL_LARGE_MODEL;
});

describe('Mistral-Large-4 BFT family slot', () => {
  it('does not add mistral-large when flag unset even if key present', () => {
    process.env.MISTRAL_API_KEY = 'k';
    process.env.HAL_QUORUM_AUTOBACKFILL = 'false';
    process.env.HAL_S2_ENABLE_MISTRAL = 'false';
    const providers = buildFactCheckProviders();
    expect(providers.some((p) => p.name === 'mistral-large')).toBe(false);
  });

  it('adds mistral-large with family mistral when flag is the string true', () => {
    process.env.MISTRAL_API_KEY = 'k';
    process.env.HAL_S2_ENABLE_MISTRAL_LARGE = 'true';
    process.env.HAL_QUORUM_AUTOBACKFILL = 'false';
    const providers = buildFactCheckProviders();
    const large = providers.find((p) => p.name === 'mistral-large');
    expect(large).toBeDefined();
    expect(large?.family).toBe('mistral');
    expect(large?.model).toBe('mistral-large-latest');
    expect(providers.some((p) => p.name === 'mistral')).toBe(false);
  });
});
