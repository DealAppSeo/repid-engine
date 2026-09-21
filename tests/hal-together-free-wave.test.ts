/**
 * Together.ai in the free wave — the one part of #743 that main did not already have.
 *
 * WHAT THESE PIN, AND WHY EACH ONE.
 *
 * #743 backfilled this provider on key presence "like zai". This port deliberately does
 * NOT: Together is a host the quorum has never dialled, and the rule this repo already
 * wrote for nvidiaNim — "a stray key must not silently widen the load-bearing quorum" —
 * applies with more force to a new vendor than to one already in the rotation. So the
 * opt-in is the behaviour worth a test: a present key alone must not be enough.
 *
 * The family matters as much as the provider. FREE_WAVE_STOP_FAMILIES and
 * MIN_QUORUM_FOR_VETO both count DISTINCT FAMILIES, and groq's live model is
 * openai/gpt-oss-20b (family `openai`). A Together vote is only worth adding because it
 * is `llama` — an independent family, not a second `openai` voice wearing another name.
 */
import { buildFactCheckProviders, buildFactCheckProvidersWith } from '../src/hal/fact-check';
import { PROVIDER_URLS } from '../src/egress/provider-hosts';

const KEY = 'TOGETHER_API_KEY';
const MODEL = 'HAL_S2_TOGETHER_MODEL';

function providers(enabled: Record<string, boolean> = {}) {
  return buildFactCheckProvidersWith(enabled as never) ?? [];
}
const together = (enabled?: Record<string, boolean>) =>
  providers(enabled).find((p) => p.name === 'together');

beforeEach(() => {
  delete process.env[KEY];
  delete process.env[MODEL];
  delete process.env['HAL_S2_ENABLE_TOGETHER'];
});

describe('opt-in, not auto-backfilled', () => {
  it('a present key ALONE does not add it — a stray key cannot widen the quorum', () => {
    process.env[KEY] = 'tg-key';
    expect(together()).toBeUndefined();
  });

  it('no key + enabled does not add it either', () => {
    expect(together({ together: true })).toBeUndefined();
  });

  it('key AND enabled adds it', () => {
    process.env[KEY] = 'tg-key';
    expect(together({ together: true })).toBeDefined();
  });
});

describe('what it contributes to the quorum', () => {
  beforeEach(() => {
    process.env[KEY] = 'tg-key';
  });

  it('is the llama family — independent of groq, which is family openai', () => {
    const t = together({ together: true });
    expect(t?.family).toBe('llama');
    // The whole reason it earns a slot: it is not a second `openai` voice.
    const g = providers({ together: true, groq: true }).find((p) => p.name === 'groq');
    if (g) expect(g.family).not.toBe('llama');
  });

  it('is a free-tier provider, so the free wave can use it before escalating', () => {
    expect(together({ together: true })?.tier).toBe('free');
  });
});

describe('egress: registry host, no new literal', () => {
  beforeEach(() => {
    process.env[KEY] = 'tg-key';
  });

  it('dials the host from PROVIDER_URLS, not an inline string', () => {
    expect(together({ together: true })?.endpoint).toBe(PROVIDER_URLS.togetherChatCompletions);
    expect(together({ together: true })?.endpoint).toBe('https://api.together.xyz/v1/chat/completions');
  });

  it('carries a model id, and the operator can override it', () => {
    expect(together({ together: true })?.model).toBeTruthy();
    process.env[MODEL] = 'meta-llama/Other-Model';
    expect(together({ together: true })?.model).toBe('meta-llama/Other-Model');
  });
});

describe('the env path maps the flag too (a builder-only fix would be half a port)', () => {
  it('HAL_S2_ENABLE_TOGETHER=true + key reaches buildFactCheckProviders()', () => {
    process.env[KEY] = 'tg-key';
    expect(buildFactCheckProviders().map((p) => p.name)).not.toContain('together');
    process.env['HAL_S2_ENABLE_TOGETHER'] = 'true';
    expect(buildFactCheckProviders().map((p) => p.name)).toContain('together');
  });
});
