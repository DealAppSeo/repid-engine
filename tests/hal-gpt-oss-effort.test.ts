/**
 * gpt-oss in the HAL quorum asks for LOW reasoning effort (Lane A, 2026-10-16).
 *
 * Measured on hal-v1-frozen (40 rows, free providers): groq gpt-oss-20b spent all 512 tokens reasoning on
 * 5-7 rows (finish_reason 'length', content empty), so its family was lost on those rows. The classify
 * voters already send reasoning_effort 'low' for gpt-oss; the HAL request body did not.
 */
import { providerBody, type FactCheckProviderCfg } from '../src/hal/fact-check';

const cfg = (model: string, extra: Partial<FactCheckProviderCfg> = {}): FactCheckProviderCfg => ({ name: 'groq', endpoint: 'http://x.test/v1', apiKey: 'k', model, ...extra });

describe('HAL request body: gpt-oss reasoning effort', () => {
  it('gpt-oss on any host asks for low effort', () => {
    expect(JSON.parse(providerBody(cfg('openai/gpt-oss-20b'), 'claim', 512)).reasoning_effort).toBe('low');
    expect(JSON.parse(providerBody(cfg('accounts/fireworks/models/gpt-oss-120b', { name: 'fireworks' }), 'claim', 512)).reasoning_effort).toBe('low');
  });

  it('other models are unchanged, and the anthropic dialect never carries it', () => {
    expect(JSON.parse(providerBody(cfg('deepseek-chat', { name: 'deepseek' }), 'claim', 512))).not.toHaveProperty('reasoning_effort');
    expect(JSON.parse(providerBody(cfg('glm-4.5-flash', { name: 'zai' }), 'claim', 512))).not.toHaveProperty('reasoning_effort');
    expect(JSON.parse(providerBody(cfg('claude-haiku-4-5', { name: 'anthropic', dialect: 'anthropic' }), 'claim', 512))).not.toHaveProperty('reasoning_effort');
  });
});
