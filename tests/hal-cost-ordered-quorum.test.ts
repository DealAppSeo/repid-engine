/**
 * S-R6 — cheapest-first quorum assembly. factCheck calls providers in cost tiers (free → cheap →
 * escalation) and STOPS the moment >= 2 distinct families respond, so paid providers are only hit
 * when the free tier can't form a quorum. Reversible via HAL_QUORUM_COST_ORDERED=false. Also covers
 * costTierOf. Mocks global.fetch + src/db so no network/Supabase.
 */
jest.mock('../src/db', () => ({ db: { from: () => ({ insert: () => Promise.resolve({ error: null }) }) } }));

import { factCheck, costTierOf, buildFactCheckProviders, FactCheckProviderCfg } from '../src/hal/fact-check';

describe('buildFactCheckProviders reads enable flags (R5/R6 wiring)', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  it('gemini/deepseek/cerebras appear only when key is set', () => {
    delete process.env.GEMINI_API_KEY; delete process.env.DEEPSEEK_API_KEY; delete process.env.CEREBRAS_API_KEY;
    expect(buildFactCheckProviders().map((p) => p.name)).toEqual([]);
    process.env.DEEPSEEK_API_KEY = 'k';
    expect(buildFactCheckProviders().map((p) => p.name)).toEqual(['deepseek']);
    process.env.CEREBRAS_API_KEY = 'k';
    expect(buildFactCheckProviders().map((p) => p.name)).toEqual(['deepseek', 'cerebras']);
    process.env.GEMINI_API_KEY = 'k';
    expect(buildFactCheckProviders().map((p) => p.name)).toEqual(['deepseek', 'cerebras', 'gemini']);
    const fams = buildFactCheckProviders();
    expect(fams.find((p) => p.name === 'gemini')?.family).toBe('gemini');
    // cost tiers classify correctly for the cheapest-first waves
    expect(costTierOf({ name: 'gemini', family: 'gemini' })).toBe('free');
  });
});

const called: string[] = [];
const okBody = { choices: [{ message: { content: '{"verdict":"TRUE","confidence":90}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
beforeEach(() => {
  called.length = 0;
  delete process.env.HAL_QUORUM_COST_ORDERED;
  (global as any).fetch = jest.fn(async (url: string) => {
    called.push(String(url));
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => okBody, text: async () => '' } as any;
  });
});

const P = (name: string, family: string, tier?: any): FactCheckProviderCfg =>
  ({ name, endpoint: `http://${name}`, apiKey: 'k', model: `${family}-model`, family, tier });

describe('costTierOf', () => {
  it('free / cheap / escalation classes', () => {
    expect(costTierOf({ name: 'groq', family: 'llama' })).toBe('free');
    expect(costTierOf({ name: 'gemini', family: 'gemini' })).toBe('free');
    expect(costTierOf({ name: 'cerebras', family: 'glm' })).toBe('free');
    expect(costTierOf({ name: 'mistral', family: 'mistral' })).toBe('free');
    expect(costTierOf({ name: 'qwen', family: 'qwen' })).toBe('free');
    expect(costTierOf({ name: 'deepseek', family: 'deepseek' })).toBe('cheap');
    expect(costTierOf({ name: 'fireworks', family: 'kimi' })).toBe('escalation');
    expect(costTierOf({ name: 'anthropic', family: 'anthropic' })).toBe('escalation');
  });
});

describe('cheapest-first quorum assembly', () => {
  const providers = [P('groq', 'llama'), P('gemini', 'gemini'), P('deepseek', 'deepseek')];

  it('2 free families respond → paid deepseek is NOT called', async () => {
    const r = await factCheck('claim', providers);
    expect(r.families_used).toBe(2);
    expect(called.some((u) => u.includes('groq'))).toBe(true);
    expect(called.some((u) => u.includes('gemini'))).toBe(true);
    expect(called.some((u) => u.includes('deepseek'))).toBe(false); // escalation avoided → cost saved
  });

  it('only 1 free family up → escalates to cheap deepseek to reach quorum', async () => {
    // gemini fails this run; free wave yields 1 family → must add deepseek.
    (global as any).fetch = jest.fn(async (url: string) => {
      called.push(String(url));
      if (String(url).includes('gemini')) return { status: 500, ok: false, headers: { get: () => null }, json: async () => ({}), text: async () => 'err' } as any;
      return { status: 200, ok: true, headers: { get: () => null }, json: async () => okBody, text: async () => '' } as any;
    });
    const r = await factCheck('claim', providers);
    expect(called.some((u) => u.includes('deepseek'))).toBe(true); // escalated because free couldn't form quorum
    expect(r.families_used).toBe(2); // groq + deepseek
  });

  it('cost-ordering OFF → all providers called in parallel (revert)', async () => {
    process.env.HAL_QUORUM_COST_ORDERED = 'false';
    await factCheck('claim', providers);
    expect(called.some((u) => u.includes('deepseek'))).toBe(true); // all called regardless
  });
});
