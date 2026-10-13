/**
 * Ministral-8B HAL pre-screen. Flags default OFF. No-key stub fail-open.
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
jest.mock('../src/selfhost/egress-guard', () => ({
  assertPromptEgressAllowed: jest.fn(),
  onlyAttestationsLeave: () => false,
}));

import { HalService } from '../src/hal/service';
import { factCheck } from '../src/hal/fact-check';
import { providerFetch } from '../src/egress/provider-fetch';
import { PROVIDER_URLS } from '../src/egress/provider-hosts';
import {
  ministralPrescreen,
  ministralPrescreenEnabled,
  MINISTRAL_MODEL_DEFAULT,
} from '../src/hal/ministral-prescreen';
import type { FactCheckProviderCfg } from '../src/hal/fact-check';

const PARIS = 'The capital of France is Paris.';
const HAIKU = 'Write a haiku about rain.';

function svc() {
  return new HalService(() => [
    { name: 'groq', endpoint: 'x', apiKey: 'k', model: 'm' } as FactCheckProviderCfg,
  ]);
}

function mistralReply(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  } as Response;
}

beforeEach(() => {
  (factCheck as jest.Mock).mockClear();
  (providerFetch as jest.Mock).mockReset();
  delete process.env.HAL_MINISTRAL_PRESCREEN_ENABLED;
  delete process.env.MISTRAL_API_KEY;
  delete process.env.HAL_JEV_PREFILTER_ENABLED;
});

describe('HAL_MINISTRAL_PRESCREEN_ENABLED', () => {
  it('defaults false (unset is off)', () => {
    expect(ministralPrescreenEnabled()).toBe(false);
  });

  it('is only on when the env is the string true', () => {
    process.env.HAL_MINISTRAL_PRESCREEN_ENABLED = 'true';
    expect(ministralPrescreenEnabled()).toBe(true);
    process.env.HAL_MINISTRAL_PRESCREEN_ENABLED = '1';
    expect(ministralPrescreenEnabled()).toBe(false);
  });
});

describe('no-key stub is fail-open', () => {
  it('flag on + no MISTRAL_API_KEY → unavailable, no fetch', async () => {
    process.env.HAL_MINISTRAL_PRESCREEN_ENABLED = 'true';
    const r = await ministralPrescreen(PARIS);
    expect(r.skipHal).toBe(false);
    expect(r.reason).toBe('unavailable');
    expect(providerFetch as jest.Mock).not.toHaveBeenCalled();
  });
});

describe('Paris still reaches HAL when flag off', () => {
  it('does not call Ministral and still calls factCheck for Paris', async () => {
    const r = await svc().evaluate({ text: PARIS });
    expect(providerFetch as jest.Mock).not.toHaveBeenCalled();
    expect(factCheck as jest.Mock).toHaveBeenCalledTimes(1);
    expect(r.mode).toBe('fact-check');
  });
});

describe('skipped_not_factual does not call HAL', () => {
  it('flag on + Ministral not-factual → factCheck is not called', async () => {
    process.env.HAL_MINISTRAL_PRESCREEN_ENABLED = 'true';
    process.env.MISTRAL_API_KEY = 'k';
    (providerFetch as jest.Mock).mockResolvedValue(mistralReply(JSON.stringify({ factual: false })));

    const r = await svc().evaluate({ text: HAIKU });
    expect(factCheck as jest.Mock).not.toHaveBeenCalled();
    expect(r.decision_reason).toBe('skipped_not_factual');
    expect(r.decision).toBe('abstain');
    const [url, init] = (providerFetch as jest.Mock).mock.calls[0];
    expect(url).toBe(PROVIDER_URLS.mistralChatCompletions);
    const body = JSON.parse(init.body);
    expect(body.model).toBe(MINISTRAL_MODEL_DEFAULT);
  });
});
