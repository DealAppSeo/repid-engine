/**
 * HAL fact-check evaluator — deterministic unit tests (mocked fetch, no network).
 * Covers aggregation, decision thresholds, JSON-parse robustness, resilience
 * (3/2/1/0 providers), env thresholds, and provider builder.
 */
import { factCheck, factCheckOptsFromEnv, buildFactCheckProviders, type FactCheckProviderCfg } from '../../src/hal/fact-check';

const P: FactCheckProviderCfg[] = [
  { name: 'p1', endpoint: 'http://x/1', apiKey: 'k1', model: 'm1' },
  { name: 'p2', endpoint: 'http://x/2', apiKey: 'k2', model: 'm2' },
  { name: 'p3', endpoint: 'http://x/3', apiKey: 'k3', model: 'm3' },
];

const originalFetch = global.fetch;

// model -> response: object verdict | 'HTTP500' | 'REJECT' | 'EMPTY' | raw string
let byModel: Record<string, any> = {};
beforeEach(() => {
  byModel = {};
  (global as any).fetch = jest.fn(async (_url: string, init: any) => {
    const model = JSON.parse(init.body).model;
    const r = byModel[model];
    if (r === 'REJECT') throw new Error('network down');
    if (r === 'HTTP500') return { ok: false, status: 500, text: async () => 'server error' } as any;
    const content = r === 'EMPTY' ? '' : typeof r === 'string' ? r : JSON.stringify(r);
    return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) } as any;
  });
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('factCheck — aggregation + decision', () => {
  test('all confident TRUE → low score → clean', async () => {
    byModel = { m1: { verdict: 'TRUE', confidence: 100 }, m2: { verdict: 'TRUE', confidence: 100 }, m3: { verdict: 'TRUE', confidence: 80 } };
    const r = await factCheck('x', P);
    expect(r.providers_used).toBe(3);
    expect(r.hal_score).toBeLessThan(0.15);
    expect(r.decision).toBe('clean');
    expect(r.degraded).toBe(false);
    expect(r.agreement).toBe(1);
  });

  test('all confident FALSE → high score → vetoed', async () => {
    byModel = { m1: { verdict: 'FALSE', confidence: 100 }, m2: { verdict: 'FALSE', confidence: 90 }, m3: { verdict: 'FALSE', confidence: 100 } };
    const r = await factCheck('x', P);
    expect(r.hal_score).toBeGreaterThan(0.9);
    expect(r.decision).toBe('vetoed');
  });

  test('mixed → flagged (between thresholds)', async () => {
    // one FALSE(100)=1.0, two TRUE(60)=0.2 each → mean = (1.0+0.2+0.2)/3 = 0.467 → flagged @0.35/0.5
    byModel = { m1: { verdict: 'FALSE', confidence: 100 }, m2: { verdict: 'TRUE', confidence: 60 }, m3: { verdict: 'TRUE', confidence: 60 } };
    const r = await factCheck('x', P);
    expect(r.decision).toBe('flagged');
  });

  test('UNCERTAIN → 0.5 risk each', async () => {
    byModel = { m1: { verdict: 'UNCERTAIN', confidence: 50 }, m2: { verdict: 'UNCERTAIN', confidence: 50 }, m3: { verdict: 'UNCERTAIN', confidence: 50 } };
    const r = await factCheck('x', P);
    expect(r.hal_score).toBeCloseTo(0.5, 5);
  });
});

describe('factCheck — JSON parse robustness', () => {
  test('verbose preamble around JSON still parses', async () => {
    byModel = { m1: 'Sure! Here is my assessment:\n{"verdict":"FALSE","confidence":95,"note":"wrong"} done', m2: { verdict: 'FALSE', confidence: 90 }, m3: { verdict: 'FALSE', confidence: 90 } };
    const r = await factCheck('x', P);
    expect(r.decision).toBe('vetoed');
    expect(r.verdicts.find((v) => v.provider === 'p1')!.verdict).toBe('FALSE');
  });
});

describe('factCheck — resilience (3/2/1/0)', () => {
  test('2 providers up (one HTTP500) → not degraded, score from 2', async () => {
    byModel = { m1: { verdict: 'FALSE', confidence: 100 }, m2: 'HTTP500', m3: { verdict: 'FALSE', confidence: 100 } };
    const r = await factCheck('x', P);
    expect(r.providers_used).toBe(2);
    expect(r.degraded).toBe(false);
    expect(r.decision).toBe('vetoed');
  });

  test('1 provider up (two fail) → degraded, still scored', async () => {
    byModel = { m1: { verdict: 'TRUE', confidence: 100 }, m2: 'REJECT', m3: 'EMPTY' };
    const r = await factCheck('x', P);
    expect(r.providers_used).toBe(1);
    expect(r.degraded).toBe(true);
    expect(r.decision).toBe('clean');
  });

  test('0 providers up → providers_used 0, neutral 0.5, degraded', async () => {
    byModel = { m1: 'REJECT', m2: 'HTTP500', m3: 'EMPTY' };
    const r = await factCheck('x', P);
    expect(r.providers_used).toBe(0);
    expect(r.hal_score).toBe(0.5);
    expect(r.degraded).toBe(true);
  });
});

describe('factCheck — env thresholds + provider builder', () => {
  test('factCheckOptsFromEnv defaults + override + flag<=veto clamp', () => {
    delete process.env.HAL_VETO_THRESHOLD; delete process.env.HAL_FLAG_THRESHOLD;
    expect(factCheckOptsFromEnv()).toEqual({ vetoThreshold: 0.5, flagThreshold: 0.35 });
    process.env.HAL_VETO_THRESHOLD = '0.3';
    expect(factCheckOptsFromEnv().vetoThreshold).toBe(0.3);
    expect(factCheckOptsFromEnv().flagThreshold).toBe(0.3); // clamped to <= veto
    process.env.HAL_VETO_THRESHOLD = '5'; // out of range → default
    expect(factCheckOptsFromEnv().vetoThreshold).toBe(0.5);
    delete process.env.HAL_VETO_THRESHOLD; delete process.env.HAL_FLAG_THRESHOLD;
  });

  test('lower veto threshold flips flagged→vetoed', async () => {
    // Isolate pure threshold mechanics from the default-ON plurality guard (cycle2). This mock has a
    // TRUE plurality (2 TRUE > 1 FALSE), which the guard would otherwise use to downgrade the
    // low-threshold veto — so disable it here. The guard has its own dedicated coverage below.
    const savedPG = process.env.HAL_PLURALITY_GUARD;
    process.env.HAL_PLURALITY_GUARD = 'false';
    try {
      byModel = { m1: { verdict: 'FALSE', confidence: 100 }, m2: { verdict: 'TRUE', confidence: 60 }, m3: { verdict: 'TRUE', confidence: 60 } }; // 0.467
      expect((await factCheck('x', P, { vetoThreshold: 0.5, flagThreshold: 0.35 })).decision).toBe('flagged');
      expect((await factCheck('x', P, { vetoThreshold: 0.4, flagThreshold: 0.3 })).decision).toBe('vetoed');
    } finally {
      if (savedPG === undefined) delete process.env.HAL_PLURALITY_GUARD; else process.env.HAL_PLURALITY_GUARD = savedPG;
    }
  });

  test('buildFactCheckProviders includes only keyed providers', () => {
    // 2026-07-07: HAL_QUORUM_AUTOBACKFILL defaults ON. Disable it here to assert the pure per-provider
    // opt-in set (groq+cerebras only), independent of which backfill keys the ambient .env happens to set.
    const save = { g: process.env.GROQ_API_KEY, c: process.env.CEREBRAS_API_KEY, f: process.env.FIREWORKS_API_KEY, fw_en: process.env.HAL_S2_ENABLE_FIREWORKS, ab: process.env.HAL_QUORUM_AUTOBACKFILL, d: process.env.DEEPSEEK_API_KEY, gm: process.env.GEMINI_API_KEY, ms: process.env.MISTRAL_API_KEY, or: process.env.OPENROUTER_API_KEY, cm: process.env.HAL_S2_CEREBRAS_MODEL };
    process.env.HAL_QUORUM_AUTOBACKFILL = 'false';
    // Cerebras now has NO default model — every id this repo shipped is retired, so unconfigured
    // means skipped (src/hal/retired-models.ts). This test asserts KEY gating, so give it an id.
    process.env.HAL_S2_CEREBRAS_MODEL = 'a-live-model-id';
    delete process.env.DEEPSEEK_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.MISTRAL_API_KEY; delete process.env.OPENROUTER_API_KEY;
    process.env.GROQ_API_KEY = 'g'; process.env.CEREBRAS_API_KEY = 'c'; delete process.env.FIREWORKS_API_KEY;
    // COMPARED ORDER-INSENSITIVELY, and the change is deliberate. This test is about KEY GATING —
    // its own name says "includes only keyed providers" — and `toEqual` on the raw array also
    // pinned REGISTRATION ORDER, which was incidental to that question and is now deliberately
    // different: cerebras registers after the fixed-family members so its catalog pick can see
    // which families the panel has actually taken (see the builder's comment at that call site,
    // and the production selection that motivated it).
    //
    // Sorting drops ONLY the ordering. "Exactly these providers, no more and no fewer" — the thing
    // this test exists to assert — is unchanged, and a provider appearing or vanishing still fails.
    const ps = buildFactCheckProviders();
    expect(ps.map((p) => p.name).sort()).toEqual(['cerebras', 'groq']);
    process.env.FIREWORKS_API_KEY = 'f'; process.env.HAL_S2_ENABLE_FIREWORKS = 'true';
    expect(buildFactCheckProviders().map((p) => p.name).sort()).toEqual(['cerebras', 'fireworks', 'groq']);
    // restore
    process.env.GROQ_API_KEY = save.g; process.env.CEREBRAS_API_KEY = save.c; process.env.FIREWORKS_API_KEY = save.f; process.env.HAL_S2_ENABLE_FIREWORKS = save.fw_en;
    process.env.HAL_QUORUM_AUTOBACKFILL = save.ab; process.env.DEEPSEEK_API_KEY = save.d; process.env.GEMINI_API_KEY = save.gm; process.env.MISTRAL_API_KEY = save.ms; process.env.OPENROUTER_API_KEY = save.or;
    for (const [k, v] of [['GROQ_API_KEY', save.g], ['CEREBRAS_API_KEY', save.c], ['FIREWORKS_API_KEY', save.f], ['HAL_S2_ENABLE_FIREWORKS', save.fw_en], ['HAL_QUORUM_AUTOBACKFILL', save.ab], ['DEEPSEEK_API_KEY', save.d], ['GEMINI_API_KEY', save.gm], ['MISTRAL_API_KEY', save.ms], ['OPENROUTER_API_KEY', save.or], ['HAL_S2_CEREBRAS_MODEL', save.cm]] as const) {
      if (v === undefined) delete process.env[k];
    }
  });
});

describe('verdict-driven gate (CC1 / W6) — veto requires a FALSE quorum', () => {
  const prev = process.env.HAL_VERDICT_DRIVEN_VETO;
  afterEach(() => {
    if (prev === undefined) delete process.env.HAL_VERDICT_DRIVEN_VETO;
    else process.env.HAL_VERDICT_DRIVEN_VETO = prev;
  });

  test('flag OFF: all-UNCERTAIN still over-vetoes (score 0.5) — zero behavior change', async () => {
    delete process.env.HAL_VERDICT_DRIVEN_VETO;
    byModel = { m1: { verdict: 'UNCERTAIN', confidence: 100 }, m2: { verdict: 'UNCERTAIN', confidence: 100 }, m3: { verdict: 'UNCERTAIN', confidence: 100 } };
    const r = await factCheck('Jazz is the most beautiful music.', P);
    expect(r.hal_score).toBeCloseTo(0.5, 5);
    expect(r.decision).toBe('vetoed'); // the W6 over-veto, preserved when the gate is OFF
  });

  test('flag ON: all-UNCERTAIN (opinion/question) → flagged, not vetoed', async () => {
    process.env.HAL_VERDICT_DRIVEN_VETO = 'true';
    byModel = { m1: { verdict: 'UNCERTAIN', confidence: 100 }, m2: { verdict: 'UNCERTAIN', confidence: 100 }, m3: { verdict: 'UNCERTAIN', confidence: 100 } };
    const r = await factCheck('Jazz is the most beautiful music.', P);
    expect(r.decision).toBe('flagged');
    expect(r.quorum_note).toMatch(/no FALSE quorum/);
  });

  test('flag ON: FALSE quorum (3 FALSE) → still vetoed', async () => {
    process.env.HAL_VERDICT_DRIVEN_VETO = 'true';
    byModel = { m1: { verdict: 'FALSE', confidence: 100 }, m2: { verdict: 'FALSE', confidence: 90 }, m3: { verdict: 'FALSE', confidence: 100 } };
    const r = await factCheck('The Mona Lisa was painted by Picasso.', P);
    expect(r.decision).toBe('vetoed');
  });

  test('flag ON: 2 FALSE + 1 UNCERTAIN → FALSE quorum → vetoed', async () => {
    process.env.HAL_VERDICT_DRIVEN_VETO = 'true';
    byModel = { m1: { verdict: 'FALSE', confidence: 100 }, m2: { verdict: 'FALSE', confidence: 100 }, m3: { verdict: 'UNCERTAIN', confidence: 100 } };
    const r = await factCheck('x', P);
    expect(r.decision).toBe('vetoed');
  });

  test('flag ON: 1 FALSE + 2 UNCERTAIN → no FALSE quorum → flagged', async () => {
    process.env.HAL_VERDICT_DRIVEN_VETO = 'true';
    byModel = { m1: { verdict: 'FALSE', confidence: 100 }, m2: { verdict: 'UNCERTAIN', confidence: 100 }, m3: { verdict: 'UNCERTAIN', confidence: 100 } };
    const r = await factCheck('x', P);
    expect(r.decision).toBe('flagged');
  });
});

describe('A1 verdict-count decision mode (HAL_DECISION_MODE=verdict)', () => {
  const prev = process.env.HAL_DECISION_MODE;
  beforeEach(() => { process.env.HAL_DECISION_MODE = 'verdict'; });
  afterEach(() => { if (prev === undefined) delete process.env.HAL_DECISION_MODE; else process.env.HAL_DECISION_MODE = prev; });

  test('2 FALSE families → vetoed with a human-readable reason', async () => {
    byModel = { m1: { verdict: 'FALSE', confidence: 100 }, m2: { verdict: 'FALSE', confidence: 100 }, m3: { verdict: 'TRUE', confidence: 80 } };
    const r = await factCheck('The Mona Lisa was painted by Picasso.', P);
    expect(r.decision).toBe('vetoed');
    expect(r.decision_reason).toMatch(/2 of 3 independent model families judged this claim FALSE/);
  });

  test('2 FALSE from the SAME family → NOT a quorum → flagged (independence)', async () => {
    const sameFam = [
      { name: 'pa', endpoint: 'http://x/a', apiKey: 'k', model: 'llama-3-a' },
      { name: 'pb', endpoint: 'http://x/b', apiKey: 'k', model: 'llama-3-b' }, // same family 'llama'
      { name: 'pc', endpoint: 'http://x/c', apiKey: 'k', model: 'gemini-2.5' },
    ];
    byModel = { 'llama-3-a': { verdict: 'FALSE', confidence: 100 }, 'llama-3-b': { verdict: 'FALSE', confidence: 100 }, 'gemini-2.5': { verdict: 'UNCERTAIN', confidence: 100 } };
    const r = await factCheck('x', sameFam as any);
    expect(r.decision).toBe('flagged'); // only 1 distinct FALSE family (llama) → no quorum
    expect(r.decision_reason).toMatch(/Only 1 family judged this FALSE/);
  });

  test('all UNCERTAIN → abstain (not a checkable claim)', async () => {
    byModel = { m1: { verdict: 'UNCERTAIN', confidence: 100 }, m2: { verdict: 'UNCERTAIN', confidence: 100 }, m3: { verdict: 'UNCERTAIN', confidence: 100 } };
    const r = await factCheck('Jazz is the most beautiful music.', P);
    expect(r.decision).toBe('abstain');
    expect(r.decision_reason).toMatch(/not a checkable factual claim/);
  });

  test('TRUE quorum, no FALSE → clean', async () => {
    byModel = { m1: { verdict: 'TRUE', confidence: 100 }, m2: { verdict: 'TRUE', confidence: 100 }, m3: { verdict: 'UNCERTAIN', confidence: 100 } };
    const r = await factCheck('Paris is the capital of France.', P);
    expect(r.decision).toBe('clean');
  });
});

// CYCLE2 plurality guard — DEFAULT-ON (opt-out via HAL_PLURALITY_GUARD=false). A FALSE minority must
// never veto a TRUE plurality: a would-be 'vetoed' is downgraded to 'clean' (TRUE outright majority)
// or 'flagged' (TRUE plurality but not majority). Guards the precision win from feat/hal-precision-cycle3.
describe('plurality guard (cycle2, default-on)', () => {
  const savedPG = process.env.HAL_PLURALITY_GUARD;
  afterEach(() => {
    if (savedPG === undefined) delete process.env.HAL_PLURALITY_GUARD;
    else process.env.HAL_PLURALITY_GUARD = savedPG;
  });

  test('default ON: FALSE minority (2 TRUE > 1 FALSE) → veto downgraded to clean', async () => {
    delete process.env.HAL_PLURALITY_GUARD; // exercise the default
    byModel = { m1: { verdict: 'FALSE', confidence: 100 }, m2: { verdict: 'TRUE', confidence: 60 }, m3: { verdict: 'TRUE', confidence: 60 } }; // 0.467
    const r = await factCheck('x', P, { vetoThreshold: 0.4, flagThreshold: 0.3 });
    expect(r.decision).toBe('clean'); // 2 TRUE is an outright majority of 3 → clean
  });

  test('opt-out (=false): same input vetoes at the low threshold', async () => {
    process.env.HAL_PLURALITY_GUARD = 'false';
    byModel = { m1: { verdict: 'FALSE', confidence: 100 }, m2: { verdict: 'TRUE', confidence: 60 }, m3: { verdict: 'TRUE', confidence: 60 } }; // 0.467
    const r = await factCheck('x', P, { vetoThreshold: 0.4, flagThreshold: 0.3 });
    expect(r.decision).toBe('vetoed');
  });

  test('does NOT rescue a genuine FALSE majority', async () => {
    delete process.env.HAL_PLURALITY_GUARD;
    byModel = { m1: { verdict: 'FALSE', confidence: 100 }, m2: { verdict: 'FALSE', confidence: 90 }, m3: { verdict: 'TRUE', confidence: 60 } };
    const r = await factCheck('x', P);
    expect(r.decision).toBe('vetoed'); // FALSE is the plurality → guard is a no-op
  });
});
