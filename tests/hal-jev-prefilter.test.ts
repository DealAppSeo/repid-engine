/**
 * JEV prefilter — cheap OpenRouter typesafe/jev-1.13 hop before HAL quorum.
 *
 * Flag HAL_JEV_PREFILTER_ENABLED default OFF. Until Sean admits api.typesafe.ai
 * into PROVIDER_URLS, the hop is OpenRouter via existing providerFetch.
 *
 * RED then GREEN:
 *   - skipped_not_factual does not call HAL
 *   - Paris still reaches HAL when the flag is off
 */
jest.mock('../src/hal/fact-check', () => ({
  factCheck: jest.fn(async () => ({
    hal_score: 0.1,
    decision: 'clean',
    verdicts: [{ provider: 'groq', verdict: 'TRUE', confidence: 100 }],
    providers_used: 3,
    agreement: 1,
    degraded: false,
    latency_ms: 5,
  })),
  buildFactCheckProviders: () => [{ name: 'groq', endpoint: 'x', apiKey: 'k', model: 'm' }],
}));
jest.mock('../src/hal/lib/evaluate', () => ({
  evaluate: jest.fn(async () => ({ hal_score: 0.3, vetoed: false, signals: { comma_severity: null } })),
}));
jest.mock('../src/egress/provider-fetch', () => ({
  providerFetch: jest.fn(),
}));

import { HalService } from '../src/hal/service';
import { factCheck } from '../src/hal/fact-check';
import { providerFetch } from '../src/egress/provider-fetch';
import { PROVIDER_URLS } from '../src/egress/provider-hosts';
import {
  jevPrefilter,
  jevPrefilterEnabled,
  JEV_OPENROUTER_MODEL,
} from '../src/hal/jev-prefilter';
import type { FactCheckProviderCfg } from '../src/hal/fact-check';

const PARIS = 'The capital of France is Paris.';
const HAIKU = 'Write a haiku about rain.';

function svc() {
  return new HalService(() => [
    { name: 'groq', endpoint: 'x', apiKey: 'k', model: 'm' } as FactCheckProviderCfg,
  ]);
}

function orReply(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response;
}

beforeEach(() => {
  (factCheck as jest.Mock).mockClear();
  (providerFetch as jest.Mock).mockReset();
  delete process.env.HAL_JEV_PREFILTER_ENABLED;
  delete process.env.OPENROUTER_API_KEY;
});

describe('HAL_JEV_PREFILTER_ENABLED', () => {
  it('defaults false (unset is off)', () => {
    expect(jevPrefilterEnabled()).toBe(false);
  });

  it('is only on when the env is the string true', () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    expect(jevPrefilterEnabled()).toBe(true);
    process.env.HAL_JEV_PREFILTER_ENABLED = '1';
    expect(jevPrefilterEnabled()).toBe(false);
  });
});

describe('Paris still reaches HAL when flag off', () => {
  it('does not call JEV and still calls factCheck for Paris', async () => {
    const r = await svc().evaluate({ text: PARIS });
    expect(providerFetch as jest.Mock).not.toHaveBeenCalled();
    expect(factCheck as jest.Mock).toHaveBeenCalledTimes(1);
    expect((factCheck as jest.Mock).mock.calls[0][0]).toBe(PARIS);
    expect(r.mode).toBe('fact-check');
  });

  it('jevPrefilter itself is a no-op under the hold', async () => {
    const r = await jevPrefilter(PARIS);
    expect(r.skipHal).toBe(false);
    expect(r.reason).toBe('flag_off');
    expect(providerFetch as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('skipped_not_factual does not call HAL', () => {
  it('flag on + JEV not-factual → factCheck is not called', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'k';
    (providerFetch as jest.Mock).mockResolvedValue(orReply(JSON.stringify({ factual: false })));

    const r = await svc().evaluate({ text: HAIKU });
    expect(factCheck as jest.Mock).not.toHaveBeenCalled();
    expect(r.decision_reason).toBe('skipped_not_factual');
    expect(r.decision).toBe('abstain');
  });
});

describe('egress: OpenRouter typesafe/jev-1.13, not api.typesafe.ai', () => {
  it('dials PROVIDER_URLS.openrouterChatCompletions with typesafe/jev-1.13', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'k';
    (providerFetch as jest.Mock).mockResolvedValue(orReply(JSON.stringify({ factual: true })));

    await jevPrefilter(PARIS);
    expect(providerFetch as jest.Mock).toHaveBeenCalledTimes(1);
    const [url, init] = (providerFetch as jest.Mock).mock.calls[0];
    expect(url).toBe(PROVIDER_URLS.openrouterChatCompletions);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.model).toBe(JEV_OPENROUTER_MODEL);
  });

  it('does not add api.typesafe.ai to the host registry', () => {
    const hosts = Object.values(PROVIDER_URLS).join(' ');
    expect(hosts).not.toMatch(/typesafe\.ai/);
  });
});
