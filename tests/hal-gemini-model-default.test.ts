/**
 * The gemini default model must not be a retired slug, and must not float.
 *
 * Found 2026-08-04 while chasing why HAL's live quorum width had fallen from 5
 * families to 3. It was not dead keys (groq, cerebras, deepseek, mistral and gemini
 * all returned 200 on /models) and not the enable flags. It was the default model:
 * `gemini-2.0-flash` is RETIRED, so every call returned HTTP 404 "This model is no
 * longer available" and the gemini family contributed zero votes to every quorum.
 *
 * The failure was invisible because a provider that always fails looks exactly like a
 * provider that was never configured — the quorum simply came back narrower, with no
 * error anyone was reading.
 *
 * Two traps this pins:
 *   1. The `/models` list still ADVERTISES the retired slug, so listing cannot verify
 *      a model. Only a real completion call can.
 *   2. A floating alias (`-latest`) would have hidden it — and would silently change
 *      the model underneath HAL's frozen accuracy claims, which is a measurement
 *      without its ruler (CLAUDE_RULES 24).
 */

import { buildFactCheckProvidersWith } from '../src/hal/fact-check';

const ENABLE_GEMINI_ONLY = {
  groq: false,
  cerebras: false,
  fireworks: false,
  deepseek: false,
  gemini: true,
  mistral: false,
  qwen: false,
  openrouter: false,
} as const;

/** Build with a dummy key so no network is touched and no real key is read. */
function geminiCfg(env: Record<string, string | undefined> = {}) {
  const saved: Record<string, string | undefined> = {};
  const keys = ['GEMINI_API_KEY', 'HAL_S2_GEMINI_MODEL', 'OPENROUTER_API_KEY', ...Object.keys(env)];
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.env.GEMINI_API_KEY = 'test-key-not-real';
    delete process.env.HAL_S2_GEMINI_MODEL;
    // OpenRouter re-routes the gemini family when present; unset it so we exercise the
    // DIRECT Google endpoint, which is the one that carried the retired default.
    delete process.env.OPENROUTER_API_KEY;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return buildFactCheckProvidersWith({ ...ENABLE_GEMINI_ONLY }).find((p) => p.name === 'gemini');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Slugs verified 404 on the OpenAI-compatible Google endpoint. Append, never remove. */
const RETIRED = ['gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];

describe('the gemini family is actually reachable', () => {
  it('is configured at all when a key is present', () => {
    const g = geminiCfg();
    expect(g).toBeDefined();
    expect(g!.family).toBe('gemini');
  });

  it('THE REGRESSION: the default is not a retired slug', () => {
    const g = geminiCfg();
    expect(RETIRED).not.toContain(g!.model);
  });

  it('specifically, it is no longer gemini-2.0-flash', () => {
    // The exact value that 404'd on every call while looking configured.
    expect(geminiCfg()!.model).not.toBe('gemini-2.0-flash');
  });

  it('uses the OpenAI-compatible Google endpoint the fix was verified against', () => {
    expect(geminiCfg()!.endpoint).toContain('generativelanguage.googleapis.com');
    expect(geminiCfg()!.endpoint).toContain('/openai/chat/completions');
  });
});

describe('the default is PINNED, not floating', () => {
  it('does not use a -latest alias', () => {
    // A floating alias changes the model underneath HAL's frozen accuracy claims, so a
    // later comparison silently measures a different configuration. Bump deliberately.
    expect(geminiCfg()!.model).not.toMatch(/latest/);
  });

  it('names a specific version', () => {
    expect(geminiCfg()!.model).toMatch(/^gemini-\d/);
  });
});

describe('the override still works', () => {
  it('HAL_S2_GEMINI_MODEL wins over the default', () => {
    // One env var reverts or re-points this without a deploy — the cheap escape hatch
    // if 2.5-flash is retired in turn.
    expect(geminiCfg({ HAL_S2_GEMINI_MODEL: 'gemini-3.5-flash' })!.model).toBe('gemini-3.5-flash');
  });

  it('an override may legitimately be anything, including one we call retired', () => {
    // The guard is on the DEFAULT. An operator pinning an old slug on purpose is a
    // decision, not a bug, and this module must not overrule it.
    expect(geminiCfg({ HAL_S2_GEMINI_MODEL: 'gemini-2.0-flash' })!.model).toBe('gemini-2.0-flash');
  });
});

describe('no key, no provider', () => {
  it('gemini is absent when no key is set — not present-and-broken', () => {
    const saved = process.env.GEMINI_API_KEY;
    const savedOr = process.env.OPENROUTER_API_KEY;
    try {
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      const g = buildFactCheckProvidersWith({ ...ENABLE_GEMINI_ONLY }).find((p) => p.name === 'gemini');
      expect(g).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = saved;
      if (savedOr === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = savedOr;
    }
  });
});
