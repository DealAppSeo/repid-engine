/**
 * HalService unit tests — dispatch (strictness 1/2), profiles, env overrides,
 * fallback. Mocks factCheck + evaluate; injects providersFn for control.
 */
jest.mock('../../src/hal/fact-check', () => ({
  factCheck: jest.fn(async () => (global as any).__fc ?? { hal_score: 0.1, decision: 'clean', verdicts: [{ provider: 'groq', verdict: 'TRUE', confidence: 100 }], providers_used: 3, agreement: 1, degraded: false, latency_ms: 5 }),
  buildFactCheckProviders: () => [{ name: 'groq', endpoint: 'x', apiKey: 'k', model: 'm' }],
}));
jest.mock('../../src/hal/lib/evaluate', () => ({
  evaluate: jest.fn(async () => ({ hal_score: 0.3, vetoed: false, signals: { comma_severity: null } })),
}));

import { HalService } from '../../src/hal/service';
import { factCheck } from '../../src/hal/fact-check';
import { evaluate } from '../../src/hal/lib/evaluate';
import type { FactCheckProviderCfg } from '../../src/hal/fact-check';

const svc = (n = 1) => new HalService(() => Array.from({ length: n }, (_, i) => ({ name: 'p' + i, endpoint: 'x', apiKey: 'k', model: 'm' } as FactCheckProviderCfg)));

beforeEach(() => {
  (factCheck as jest.Mock).mockClear();
  (evaluate as jest.Mock).mockClear();
  (global as any).__fc = null;
  delete process.env.HAL_VETO_THRESHOLD;
  delete process.env.HAL_FLAG_THRESHOLD;
});

describe('HalService.evaluate', () => {
  test('default profile → strictness:2 → fact-check', async () => {
    const r = await svc().evaluate({ text: 'The capital of France is Paris.' });
    expect(factCheck as jest.Mock).toHaveBeenCalledTimes(1);
    expect(evaluate as jest.Mock).not.toHaveBeenCalled();
    expect(r.mode).toBe('fact-check');
    expect(r.strictness).toBe(2);
    expect(r.product).toBe('default');
    expect(r.provider_responses).toBeDefined();
  });

  test('strictness:1 override → extractor', async () => {
    const r = await svc().evaluate({ text: 'x', strictness: 1 });
    expect(evaluate as jest.Mock).toHaveBeenCalledTimes(1);
    expect(factCheck as jest.Mock).not.toHaveBeenCalled();
    expect(r.mode).toBe('extractor');
    expect(r.strictness).toBe(1);
  });

  test('product trusttrader → finance thresholds (veto 0.45/flag 0.3) + product tag', async () => {
    const r = await svc().evaluate({ text: 'AAPL will hit $500 next week.', context: { product: 'trusttrader' } });
    expect((factCheck as jest.Mock).mock.calls[0][2]).toEqual({ vetoThreshold: 0.45, flagThreshold: 0.3 });
    expect(r.product).toBe('trusttrader');
  });

  test('env HAL_VETO_THRESHOLD overrides profile', async () => {
    process.env.HAL_VETO_THRESHOLD = '0.2';
    await svc().evaluate({ text: 'x', context: { product: 'trustcre' } });
    expect((factCheck as jest.Mock).mock.calls[0][2].vetoThreshold).toBe(0.2);
  });

  test('no providers → extractor fallback', async () => {
    const r = await svc(0).evaluate({ text: 'x' });
    expect(factCheck as jest.Mock).not.toHaveBeenCalled();
    expect(evaluate as jest.Mock).toHaveBeenCalledTimes(1);
    expect(r.mode).toBe('extractor-fallback');
  });

  test('providers present but 0 responded → extractor fallback', async () => {
    (global as any).__fc = { hal_score: 0.5, decision: 'flagged', verdicts: [], providers_used: 0, agreement: null, degraded: true, latency_ms: 30 };
    const r = await svc(3).evaluate({ text: 'x' });
    expect(factCheck as jest.Mock).toHaveBeenCalledTimes(1);
    expect(evaluate as jest.Mock).toHaveBeenCalledTimes(1);
    expect(r.mode).toBe('extractor-fallback');
  });

  test('fact-check vetoed propagates', async () => {
    (global as any).__fc = { hal_score: 0.9, decision: 'vetoed', verdicts: [], providers_used: 3, agreement: 1, degraded: false, latency_ms: 6 };
    const r = await svc().evaluate({ text: 'Pluto is a planet.' });
    expect(r.decision).toBe('vetoed');
    expect(r.hal_score).toBe(0.9);
  });
});
