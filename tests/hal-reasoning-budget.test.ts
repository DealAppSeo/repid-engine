/**
 * REASONING-STYLE MODELS GET ROOM TO FINISH THINKING (N3-A1, 2026-11-02).
 *
 * Measured in production, 114 HAL_SCORE_EVENT rows (2026-11-01 22:00Z to 2026-11-02 07:53Z),
 * metadata.hal_signals.provider_health.failed:
 *   cerebras qwen-3.8-27b   "unparseable reply (finish_reason length)" x40
 *   zai      glm-4.5-flash  "unparseable reply (finish_reason length)" x8   (and 27 timeouts)
 *   deepseek deepseek-flash "unparseable reply (finish_reason length)" x14
 * These models think first and answer second. The quorum asked every provider for 512 completion
 * tokens, the host cut the thinking off at 512, `content` came back empty, and the family dropped
 * out of the quorum (it fell to 2 families).
 *
 * The fake hosts below behave the same way: a host needs N tokens of thinking before it emits the
 * verdict JSON, and cuts the reply off at the request's max_tokens with finish_reason 'length'.
 * A truncated reply STAYS unparseable: nothing is extracted from half a thought.
 */
jest.mock('../src/billing/log-call', () => ({ logLlmCall: jest.fn(async () => undefined) }));
jest.mock('../src/hal/ground-truth-gate', () => ({
  checkGroundTruth: jest.fn(async () => ({ verdict: 'no_match', corroborating: [], contradicting: [], reason: 'mocked', degraded: false })),
}));

import { completionBudget, factCheck, type FactCheckProviderCfg } from '../src/hal/fact-check';
import { logLlmCall } from '../src/billing/log-call';

const cfg = (name: string, model: string, family: string, tier: 'free' | 'cheap' = 'free'): FactCheckProviderCfg =>
  ({ name, endpoint: `http://${name}.test/v1`, apiKey: 'k', model, family, tier });

const CEREBRAS_QWEN = cfg('cerebras', 'qwen-3.8-27b', 'qwen');
const ZAI_GLM = cfg('zai', 'glm-4.5-flash', 'glm');
const GROQ_OSS = cfg('groq', 'openai/gpt-oss-20b', 'openai');
const DEEPSEEK_FLASH = cfg('deepseek', 'deepseek-flash', 'deepseek', 'cheap');

// Tokens of thinking each fake host needs before it emits the verdict JSON.
const NEEDS: Record<string, number> = { cerebras: 1200, zai: 900, deepseek: 1500, groq: 100 };

const originalFetch = global.fetch;
let sent: Array<{ host: string; max_tokens: number }>;
let needs: Record<string, number>;

const reply = (message: Record<string, unknown>, finish_reason: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message, finish_reason }], usage: { prompt_tokens: 40, completion_tokens: 0 } }),
});

beforeEach(() => {
  needs = { ...NEEDS };
  sent = [];
  (global as any).fetch = jest.fn(async (url: string, init: { body: string }) => {
    const host = new URL(String(url)).hostname.split('.')[0]!;
    const { max_tokens } = JSON.parse(init.body);
    sent.push({ host, max_tokens });
    if (max_tokens < needs[host]!) {
      // Cut off mid-thought: finish_reason 'length', no `content`, only the unfinished thinking.
      return reply({ content: '', reasoning: 'Let me think about this claim step by step. The verdict is probably TRUE, but first I should' }, 'length');
    }
    return reply({ content: '{"verdict":"TRUE","confidence":90,"note":"well established"}', reasoning: 'done thinking' }, 'stop');
  });
});
afterAll(() => {
  global.fetch = originalFetch;
});

const vote = (r: Awaited<ReturnType<typeof factCheck>>, provider: string) => r.verdicts.find((v) => v.provider === provider)!;

describe('a reasoning-style model has room to finish thinking and still return its verdict', () => {
  it('cerebras qwen-3.8-27b and zai glm-4.5-flash vote instead of being cut off at 512', async () => {
    const r = await factCheck('Paris is the capital of France.', [CEREBRAS_QWEN, ZAI_GLM, GROQ_OSS]);
    expect(vote(r, 'cerebras')).toMatchObject({ verdict: 'TRUE', confidence: 90 });
    expect(vote(r, 'zai')).toMatchObject({ verdict: 'TRUE', confidence: 90 });
    expect(vote(r, 'groq')).toMatchObject({ verdict: 'TRUE' });
    expect(r.families_used).toBe(3);
  });

  it('deepseek-flash votes too', async () => {
    const r = await factCheck('Paris is the capital of France.', [GROQ_OSS, DEEPSEEK_FLASH]);
    expect(vote(r, 'deepseek')).toMatchObject({ verdict: 'TRUE', confidence: 90 });
    expect(r.families_used).toBe(2);
  });

  it('a host that needs more than the budget is still cut off, and stays NOT_CHECKED (nothing is read out of half a thought)', async () => {
    needs.cerebras = 50_000;
    const r = await factCheck('Paris is the capital of France.', [CEREBRAS_QWEN, ZAI_GLM, GROQ_OSS]);
    expect(vote(r, 'cerebras')).toMatchObject({ verdict: 'ERROR', error: 'unparseable reply (finish_reason length)' });
    expect(r.families_used).toBe(2);
    // Bounded: the cap is finite, so a runaway thinker cannot spend an unbounded budget.
    expect(sent.find((s) => s.host === 'cerebras')!.max_tokens).toBeLessThanOrEqual(4096);
  });

  it('models that answer inside 512 keep the 512 cap', async () => {
    await factCheck('Paris is the capital of France.', [GROQ_OSS, cfg('gemini', 'gemini-2.5-flash', 'gemini'), cfg('mistral', 'mistral-small-latest', 'mistral')]);
    expect(sent.map((s) => s.max_tokens)).toEqual([512, 512, 512]);
  });
});

describe('completionBudget', () => {
  it('gives the families that think before they answer (qwen, glm, deepseek) a larger cap, by family and not by host', () => {
    for (const c of [
      CEREBRAS_QWEN,
      ZAI_GLM,
      DEEPSEEK_FLASH,
      cfg('deepseek', 'deepseek-v4-pro', 'deepseek', 'cheap'),
      { ...cfg('groq', 'qwen/qwen3.8-27b', 'qwen') }, // same family on another host
      { name: 'cerebras', endpoint: 'http://x.test', apiKey: 'k', model: 'qwen-3.8-27b' }, // no family set: derived from the model
    ]) {
      expect(completionBudget(c, 512)).toBeGreaterThan(512);
    }
  });

  it('leaves every other family at the base cap, and never lowers a larger one', () => {
    for (const c of [GROQ_OSS, cfg('gemini', 'gemini-2.5-flash', 'gemini'), cfg('mistral', 'mistral-small-latest', 'mistral'), cfg('anthropic', 'claude-haiku-4-5', 'anthropic')]) {
      expect(completionBudget(c, 512)).toBe(512);
    }
    expect(completionBudget(ZAI_GLM, 100_000)).toBe(100_000);
  });
});

describe('a reply cut off at the cap is never a vote, even when its text holds a complete verdict JSON', () => {
  // A model that drafts a provisional verdict mid-thought and is then cut off has not answered.
  const DRAFT = 'First pass: {"verdict":"FALSE","confidence":80,"note":"draft"} but let me double check the date before I commit';
  const FALSE_AT_STOP = { content: '{"verdict":"FALSE","confidence":90,"note":"wrong"}' };
  const callsTo = (provider: string) => (logLlmCall as jest.Mock).mock.calls.map((c) => c[0]).filter((e) => e.provider === provider);

  beforeEach(() => (logLlmCall as jest.Mock).mockClear());

  it.each([
    ['in content', { content: DRAFT }],
    ['in the reasoning field when content is empty', { content: '', reasoning: DRAFT }],
  ])('finish_reason length with the draft %s is an ERROR, logged as failed, and cannot complete a veto', async (_where, message) => {
    (global as any).fetch = jest.fn(async (url: string) => (String(url).includes('groq') ? reply(FALSE_AT_STOP, 'stop') : reply(message, 'length')));
    const r = await factCheck('Some claim.', [GROQ_OSS, ZAI_GLM]);
    expect(vote(r, 'zai')).toMatchObject({ verdict: 'ERROR', confidence: 0, error: 'unparseable reply (finish_reason length)' });
    expect(callsTo('zai')[0]).toMatchObject({ status: 'failed', error_message: 'unparseable reply (finish_reason length)' });
    // One real FALSE alone is held below a veto; the draft FALSE must not be the second family.
    expect(r.families_used).toBe(1);
    expect(r.decision).not.toBe('vetoed');
  });

  it('the same reply that finished (finish_reason stop) is counted, so only truncation changes', async () => {
    (global as any).fetch = jest.fn(async (url: string) => (String(url).includes('groq') ? reply(FALSE_AT_STOP, 'stop') : reply({ content: DRAFT }, 'stop')));
    const r = await factCheck('Some claim.', [GROQ_OSS, ZAI_GLM]);
    expect(vote(r, 'zai')).toMatchObject({ verdict: 'FALSE', confidence: 80 });
    expect(r.decision).toBe('vetoed');
  });

  describe('anthropic dialect: stop_reason "max_tokens" is the cap, "end_turn" is a finished answer', () => {
    const CLAUDE: FactCheckProviderCfg = { ...cfg('anthropic', 'claude-haiku-4-5', 'anthropic'), dialect: 'anthropic' };
    const claude = (stop_reason: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: '{"verdict":"FALSE","confidence":80}' }], stop_reason, usage: { input_tokens: 40, output_tokens: 20 } }),
    });

    it('max_tokens is an ERROR', async () => {
      (global as any).fetch = jest.fn(async () => claude('max_tokens'));
      const r = await factCheck('Some claim.', [CLAUDE]);
      expect(vote(r, 'anthropic')).toMatchObject({ verdict: 'ERROR', error: 'unparseable reply (finish_reason max_tokens)' });
      expect(callsTo('anthropic')[0]).toMatchObject({ status: 'failed' });
    });

    it('end_turn is counted', async () => {
      (global as any).fetch = jest.fn(async () => claude('end_turn'));
      const r = await factCheck('Some claim.', [CLAUDE]);
      expect(vote(r, 'anthropic')).toMatchObject({ verdict: 'FALSE', confidence: 80 });
    });
  });
});
