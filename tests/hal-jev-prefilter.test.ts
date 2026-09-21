/**
 * JEV prefilter — cheap OpenRouter System One hop before the HAL quorum.
 *
 * Flag HAL_JEV_PREFILTER_ENABLED default OFF. Until Sean admits api.typesafe.ai
 * into PROVIDER_URLS, the hop is OpenRouter via the existing providerFetch.
 *
 * WHAT THESE TESTS NOW PIN, AND WHY IT CHANGED.
 * The first version of this suite asserted a CHAT-COMPLETIONS request
 * (`messages: [...]` against openrouterChatCompletions, model `typesafe/jev-1.13`)
 * and it passed — against a mock built to the same wrong shape. Jev is a System One
 * model and cannot generate chat text, so that request could only 400 in production.
 * A green suite over a request the vendor rejects is the exact failure this repo
 * keeps finding: the test agreed with the code instead of with the API.
 *
 * So the egress test below now pins the REQUEST SHAPE, not just the host: route,
 * `state`, and two `noul` questions. That is the part that was wrong and the part a
 * regression would silently revert.
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
  jevModel,
  jevSkipThreshold,
  JEV_MODEL_DEFAULT,
  JEV_SKIP_THRESHOLD_DEFAULT,
} from '../src/hal/jev-prefilter';
import type { FactCheckProviderCfg } from '../src/hal/fact-check';

const PARIS = 'The capital of France is Paris.';
const HAIKU = 'Write a haiku about rain.';

function svc() {
  return new HalService(() => [
    { name: 'groq', endpoint: 'x', apiKey: 'k', model: 'm' } as FactCheckProviderCfg,
  ]);
}

/** A System One reply: a map of question key -> noul value. */
function sysOne(answers: Record<string, unknown>, ok = true) {
  return { ok, json: async () => ({ answers }) } as Response;
}

beforeEach(() => {
  (factCheck as jest.Mock).mockClear();
  (providerFetch as jest.Mock).mockReset();
  delete process.env.HAL_JEV_PREFILTER_ENABLED;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.HAL_JEV_MODEL;
  delete process.env.HAL_JEV_SKIP_THRESHOLD;
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
  it('flag on + both nouls low -> factCheck is not called', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'k';
    (providerFetch as jest.Mock).mockResolvedValue(
      sysOne({ claim_is_factual: 0.02, worth_hal_quorum: 0.04 }),
    );

    const r = await svc().evaluate({ text: HAIKU });
    expect(factCheck as jest.Mock).not.toHaveBeenCalled();
    expect(r.decision_reason).toBe('skipped_not_factual');
    expect(r.decision).toBe('abstain');
  });

  it('a high factual noul still reaches HAL', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'k';
    (providerFetch as jest.Mock).mockResolvedValue(
      sysOne({ claim_is_factual: 0.97, worth_hal_quorum: 0.95 }),
    );

    const r = await jevPrefilter(PARIS);
    expect(r.skipHal).toBe(false);
    expect(r.reason).toBe('factual');
  });

  it('worth_hal_quorum VETOES a skip even when claim_is_factual is low', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'k';
    (providerFetch as jest.Mock).mockResolvedValue(
      sysOne({ claim_is_factual: 0.1, worth_hal_quorum: 0.9 }),
    );

    const r = await jevPrefilter(HAIKU);
    expect(r.skipHal).toBe(false);
  });
});

describe('egress: OpenRouter System One route and typed-question body', () => {
  it('dials PROVIDER_URLS.openrouterSystemOne with state + two noul questions', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'k';
    (providerFetch as jest.Mock).mockResolvedValue(sysOne({ claim_is_factual: 0.9 }));

    await jevPrefilter(PARIS);
    expect(providerFetch as jest.Mock).toHaveBeenCalledTimes(1);
    const [url, init] = (providerFetch as jest.Mock).mock.calls[0];

    expect(url).toBe(PROVIDER_URLS.openrouterSystemOne);
    expect(url).toBe('https://openrouter.ai/api/v1/systemone');

    const body = JSON.parse(init.body);
    expect(body.model).toBe(JEV_MODEL_DEFAULT);
    expect(body.model).toBe('jev-1.13');
    expect(body.state).toBe(PARIS);
    expect(body.questions.claim_is_factual.type).toBe('noul');
    expect(body.questions.worth_hal_quorum.type).toBe('noul');
  });

  it('is NOT a chat completion — no messages[], and not the chat route', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'k';
    (providerFetch as jest.Mock).mockResolvedValue(sysOne({ claim_is_factual: 0.9 }));

    await jevPrefilter(PARIS);
    const [url, init] = (providerFetch as jest.Mock).mock.calls[0];
    expect(url).not.toBe(PROVIDER_URLS.openrouterChatCompletions);
    const body = JSON.parse(init.body);
    expect(body.messages).toBeUndefined();
  });

  it('caps state and never sends the raw key anywhere but the header', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'super-secret';
    (providerFetch as jest.Mock).mockResolvedValue(sysOne({ claim_is_factual: 0.9 }));

    await jevPrefilter('x'.repeat(5000));
    const [, init] = (providerFetch as jest.Mock).mock.calls[0];
    expect(JSON.parse(init.body).state).toHaveLength(2000);
    expect(init.body).not.toContain('super-secret');
    expect(init.headers.Authorization).toBe('Bearer super-secret');
  });

  it('does not add api.typesafe.ai to the host registry', () => {
    const hosts = Object.values(PROVIDER_URLS).join(' ');
    expect(hosts).not.toMatch(/typesafe\.ai/);
  });
});

describe('KILL SWITCH — if TypeSafe disappears, HAL is unchanged', () => {
  it('a thrown fetch never skips HAL', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'k';
    (providerFetch as jest.Mock).mockRejectedValue(new Error('ENOTFOUND'));

    const r = await svc().evaluate({ text: HAIKU });
    expect(factCheck as jest.Mock).toHaveBeenCalledTimes(1);
    expect(r.mode).toBe('fact-check');
    expect(r.decision_reason).not.toBe('skipped_not_factual');
  });

  it('a non-200 never skips HAL', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'k';
    (providerFetch as jest.Mock).mockResolvedValue(sysOne({}, false));

    const r = await jevPrefilter(HAIKU);
    expect(r).toEqual({ skipHal: false, reason: 'unavailable' });
  });

  it('a missing key never skips HAL and never dials out', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    const r = await jevPrefilter(HAIKU);
    expect(r).toEqual({ skipHal: false, reason: 'unavailable' });
    expect(providerFetch as jest.Mock).not.toHaveBeenCalled();
  });

  it('an unparseable body is NOT_CHECKED, not a skip', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'k';
    (providerFetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'sorry, I am a chat model' } }] }),
    } as Response);

    const r = await jevPrefilter(HAIKU);
    expect(r).toEqual({ skipHal: false, reason: 'unavailable' });
  });
});

describe('response-shape ambiguity is absorbed, not guessed', () => {
  it('accepts a bare noul number', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'k';
    (providerFetch as jest.Mock).mockResolvedValue(
      sysOne({ claim_is_factual: 0.01, worth_hal_quorum: 0.01 }),
    );
    expect((await jevPrefilter(HAIKU)).skipHal).toBe(true);
  });

  it('accepts a noul object carrying a sibling confidence field', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'k';
    (providerFetch as jest.Mock).mockResolvedValue(
      sysOne({
        claim_is_factual: { value: 0.01, confidence: 0.98 },
        worth_hal_quorum: { value: 0.02, confidence: 0.9 },
      }),
    );
    expect((await jevPrefilter(HAIKU)).skipHal).toBe(true);
  });

  it('an out-of-unit-range value is NOT_CHECKED rather than coerced', async () => {
    process.env.HAL_JEV_PREFILTER_ENABLED = 'true';
    process.env.OPENROUTER_API_KEY = 'k';
    (providerFetch as jest.Mock).mockResolvedValue(sysOne({ claim_is_factual: 42 }));
    expect(await jevPrefilter(HAIKU)).toEqual({ skipHal: false, reason: 'unavailable' });
  });
});

describe('model id and threshold are env-overridable (Groq-retirement lesson)', () => {
  it('model defaults to jev-1.13 and can be overridden without a redeploy', () => {
    expect(jevModel()).toBe('jev-1.13');
    process.env.HAL_JEV_MODEL = 'jev-2.0';
    expect(jevModel()).toBe('jev-2.0');
  });

  it('threshold defaults to the provisional value and rejects nonsense', () => {
    expect(jevSkipThreshold()).toBe(JEV_SKIP_THRESHOLD_DEFAULT);
    process.env.HAL_JEV_SKIP_THRESHOLD = '0.2';
    expect(jevSkipThreshold()).toBe(0.2);
    process.env.HAL_JEV_SKIP_THRESHOLD = 'banana';
    expect(jevSkipThreshold()).toBe(JEV_SKIP_THRESHOLD_DEFAULT);
    process.env.HAL_JEV_SKIP_THRESHOLD = '7';
    expect(jevSkipThreshold()).toBe(JEV_SKIP_THRESHOLD_DEFAULT);
  });
});
