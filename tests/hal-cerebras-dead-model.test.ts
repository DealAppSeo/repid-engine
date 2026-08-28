/**
 * The quorum must not spend a request on a model measured incapable of answering (2026-08-28).
 *
 * MEASURED, from this system's own call ledger — not from a vendor docs page:
 *   zai-glm-4.7  tens of thousands of successes, then a hard stop at 2026-08-17 11:51Z and
 *                nothing but `model_archived_error` after it. The vendor archived it mid-day.
 *   zai-glm-4.6  every call 404s `model_not_found`. It was chosen as 4.7's replacement FROM
 *                DOCUMENTATION, shipped under an explicit NOT_CHECKED caveat, and has never
 *                once returned a verdict.
 *
 * So both known ids are dead, and a live production fact-check was still calling one of them on
 * every single request — ~100ms and one request burned for a guaranteed 404, in a quorum that
 * then reported itself as `partial`.
 *
 * WHY A SKIP RATHER THAN A THIRD MODEL ID. Guessing is what produced 4.6. The docs host is
 * unreachable from a dev sandbox, so a search result is the only thing obtainable here, and a
 * search result today still reports 4.7 as current — pre-deprecation documentation that would
 * re-ship the archived model. Not calling a model we have measured cannot answer requires no
 * new id and no guess.
 *
 * THE SKIP MUST BE LOUD. `tests/hal-gemini-model-default.test.ts` records the trap this sits
 * next to: "a provider that always fails looks exactly like a provider that was never
 * configured." A reported 404 was already better than a silent absence — so a SILENT skip would
 * have been a regression, trading a loud failure for a quiet one. Only a REPORTED skip is an
 * improvement, which is why the `provider_health.skipped` tests below are load-bearing and not
 * cosmetic.
 */

// Keep the llm_call_log insert off a real Supabase; these tests are about provider selection.
jest.mock('../src/db', () => ({
  db: { from: () => ({ insert: () => Promise.resolve({ error: null }) }) },
}));

import {
  buildFactCheckProvidersWith,
  cerebrasDeadModelSkip,
  factCheck,
  type FactCheckProviderCfg,
} from '../src/hal/fact-check';
import { isRetiredModel } from '../src/hal/retired-models';

const ENABLE_CEREBRAS_ONLY = {
  groq: false,
  cerebras: true,
  fireworks: false,
  deepseek: false,
  gemini: false,
  mistral: false,
  qwen: false,
  openrouter: false,
} as const;

const TOUCHED = [
  'CEREBRAS_API_KEY',
  'HAL_S2_CEREBRAS_MODEL',
  'HAL_S2_CEREBRAS_ALLOW_DEAD_MODEL',
  'HAL_QUORUM_AUTOBACKFILL',
  'HAL_QUORUM_COST_ORDERED',
];

/** Build with a dummy key so no network is touched and no real key is read. */
function cerebrasCfg(env: Record<string, string | undefined> = {}) {
  return withEnv({ CEREBRAS_API_KEY: 'test-key-not-real', ...env }, () =>
    buildFactCheckProvidersWith({ ...ENABLE_CEREBRAS_ONLY }).find((p) => p.name === 'cerebras'),
  );
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of [...TOUCHED, ...Object.keys(env)]) saved[k] = process.env[k];
  try {
    // Start from a clean slate so an ambient .env cannot decide the outcome.
    for (const k of TOUCHED) delete process.env[k];
    process.env.HAL_QUORUM_AUTOBACKFILL = 'false'; // isolate the per-provider gate
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('a model measured dead is not called', () => {
  it('THE REGRESSION: with nothing configured, cerebras is skipped rather than dialled', () => {
    // No override set — this is what a fresh deploy does. There is deliberately no default
    // model left to fall back to, because every id this repo ever shipped is retired.
    expect(cerebrasCfg()).toBeUndefined();
  });

  it('and specifically because of the model, not the key', () => {
    // The distinction that makes the skip actionable: the credential is fine.
    const skip = withEnv({ CEREBRAS_API_KEY: 'test-key-not-real' }, () => cerebrasDeadModelSkip());
    expect(skip).not.toBeNull();
    expect(skip!.name).toBe('cerebras');
    expect(skip!.reason).toContain('HAL_S2_CEREBRAS_MODEL');
  });

  it('an override that is ALSO on the dead list is skipped too — this is the production case', () => {
    // Production pins HAL_S2_CEREBRAS_MODEL, so a guard on the default alone would have fixed
    // nothing where it actually mattered. Deliberately unlike the gemini guard, which is
    // test-side and never blocks an override; these ids are measured, not inferred.
    expect(cerebrasCfg({ HAL_S2_CEREBRAS_MODEL: 'zai-glm-4.7' })).toBeUndefined();
  });

  it('both measured-dead cerebras ids are on the shared retired list', () => {
    // Shared with tests/hal-provider-models-not-dead.test.ts, so one edit both bans an id as a
    // default and makes the quorum skip it. Two copies is how the override path stayed broken
    // while that guard was green.
    expect(isRetiredModel('zai-glm-4.6')).toBe(true);
    expect(isRetiredModel('zai-glm-4.7')).toBe(true);
  });
});

describe('it self-heals without a deploy', () => {
  it('a live model id rejoins cerebras to the quorum', () => {
    const c = cerebrasCfg({ HAL_S2_CEREBRAS_MODEL: 'some-live-model-id' });
    expect(c).toBeDefined();
    expect(c!.model).toBe('some-live-model-id');
    expect(c!.endpoint).toContain('api.cerebras.ai');
  });

  it('a bare allow flag with NO model still reports a skip — it cannot silently drop the provider', () => {
    // Order matters in the predicate: "call this retired id anyway" is meaningless with no id.
    // Checking the flag first would cost the operator the provider AND the explanation.
    const skip = withEnv(
      { CEREBRAS_API_KEY: 'test-key-not-real', HAL_S2_CEREBRAS_ALLOW_DEAD_MODEL: 'true' },
      () => cerebrasDeadModelSkip(),
    );
    expect(skip).not.toBeNull();
    expect(skip!.reason).toContain('no model configured');
  });

  it('THE OPERATOR KEEPS THE LAST WORD: the allow flag forces a dead id back in', () => {
    // What makes a runtime block defensible. Without this, restoring cerebras on an id we
    // listed would need a code change and a release — and the list is our belief, not the
    // vendor's. An operator who has just been granted access must not have to wait for us.
    const c = cerebrasCfg({
      HAL_S2_CEREBRAS_MODEL: 'zai-glm-4.7',
      HAL_S2_CEREBRAS_ALLOW_DEAD_MODEL: 'true',
    });
    expect(c).toBeDefined();
    expect(c!.model).toBe('zai-glm-4.7');
    // The key has to be present here or this passes for the wrong reason — an unkeyed build
    // returns null too, and would assert nothing about the flag.
    expect(
      withEnv(
        {
          CEREBRAS_API_KEY: 'test-key-not-real',
          HAL_S2_CEREBRAS_MODEL: 'zai-glm-4.7',
          HAL_S2_CEREBRAS_ALLOW_DEAD_MODEL: 'true',
        },
        () => cerebrasDeadModelSkip(),
      ),
    ).toBeNull();
  });

  it('the allow flag is exact — a stray truthy value does not disarm the guard', () => {
    expect(
      cerebrasCfg({
        HAL_S2_CEREBRAS_MODEL: 'zai-glm-4.7',
        HAL_S2_CEREBRAS_ALLOW_DEAD_MODEL: '1',
      }),
    ).toBeUndefined();
  });

  it('no key, no provider — and no skip claimed either', () => {
    // A missing credential is a different fact from a dead model, and conflating them would
    // send the reader to the wrong fix.
    expect(withEnv({ CEREBRAS_API_KEY: undefined }, () =>
      buildFactCheckProvidersWith({ ...ENABLE_CEREBRAS_ONLY }).find((p) => p.name === 'cerebras'),
    )).toBeUndefined();
  });
});

describe('the skip is REPORTED — an unreported skip would be a regression', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    (global as any).fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ verdict: 'TRUE', confidence: 90 }) } }],
      }),
    }));
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const live: FactCheckProviderCfg[] = [
    { name: 'groq', endpoint: 'x', apiKey: 'k', model: 'm' },
    { name: 'deepseek', endpoint: 'z', apiKey: 'k', model: 'm' },
  ];

  it('provider_health.skipped names cerebras and why it was not called', async () => {
    const r = await withEnv({ CEREBRAS_API_KEY: 'test-key-not-real' }, () =>
      factCheck('the sky is blue', live),
    );
    const skipped = r.provider_health?.skipped ?? [];
    expect(skipped.map((s) => s.name)).toContain('cerebras');
    expect(skipped[0]!.reason).toMatch(/HAL_S2_CEREBRAS_MODEL/);
  });

  it('a skipped provider is NOT counted as attempted', async () => {
    // `attempted` means calls made. Inflating it would turn a skip into a phantom failure.
    const r = await withEnv({ CEREBRAS_API_KEY: 'test-key-not-real' }, () =>
      factCheck('the sky is blue', live),
    );
    expect(r.provider_health?.attempted).toBe(live.length);
  });

  it('no skip is claimed when cerebras IS in the set being used', async () => {
    // The lie in the other direction. A caller passing its own provider list — every test in
    // this repo that uses a literal array — must not be told a provider it supplied was skipped.
    const withCerebras = [...live, { name: 'cerebras', endpoint: 'c', apiKey: 'k', model: 'm' }];
    const r = await withEnv({ CEREBRAS_API_KEY: 'test-key-not-real' }, () =>
      factCheck('the sky is blue', withCerebras),
    );
    expect(r.provider_health?.skipped).toBeUndefined();
  });

  it('the field is absent, not empty, when nothing was skipped', async () => {
    const r = await withEnv({ CEREBRAS_API_KEY: undefined }, () => factCheck('the sky is blue', live));
    expect(r.provider_health?.skipped).toBeUndefined();
  });
});
