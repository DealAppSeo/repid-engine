/**
 * A REPLY HAL CANNOT PARSE IS NOT A VOTE (Lane A, 2026-10-16).
 *
 * Measured on hal-v1-frozen with free providers: groq gpt-oss-20b ran out of tokens mid-reasoning
 * (finish_reason 'length', content empty, 512 tokens of reasoning). parseProviderResponse handed the
 * cut-off reasoning to parseVerdict, which found no JSON and returned UNCERTAIN at 50, and that
 * default was COUNTED. With one real FALSE beside it, the invented vote made a 2-family quorum and
 * the claim was vetoed (on fever-80c0806a, a TRUE claim). Now the reply is an ERROR: NOT_CHECKED,
 * not counted, and the lone FALSE is held at 'flagged'.
 */
jest.mock('../src/billing/log-call', () => ({ logLlmCall: jest.fn(async () => undefined) }));
jest.mock('../src/hal/ground-truth-gate', () => ({
  checkGroundTruth: jest.fn(async () => ({ verdict: 'no_match', corroborating: [], contradicting: [], reason: 'mocked', degraded: false })),
}));

import { factCheck, type FactCheckProviderCfg } from '../src/hal/fact-check';
import { logLlmCall } from '../src/billing/log-call';

const PROVIDERS: FactCheckProviderCfg[] = [
  { name: 'groq', endpoint: 'http://groq.test/v1', apiKey: 'k1', model: 'gpt-oss-test', family: 'openai', tier: 'free' },
  { name: 'zai', endpoint: 'http://zai.test/v1', apiKey: 'k2', model: 'glm-test', family: 'glm', tier: 'free' },
];

const reply = (message: Record<string, unknown>, finish_reason = 'stop') => ({ ok: true, status: 200, json: async () => ({ choices: [{ message, finish_reason }], usage: { prompt_tokens: 10, completion_tokens: 512 } }) });
const originalFetch = global.fetch;
let groqMessage: Record<string, unknown>;
let groqFinish = 'stop';

beforeEach(() => {
  (logLlmCall as jest.Mock).mockClear();
  (global as any).fetch = jest.fn(async (url: string) =>
    String(url).includes('groq') ? reply(groqMessage, groqFinish) : reply({ content: '{"verdict":"FALSE","confidence":100,"note":"wrong year"}' }),
  );
});
afterAll(() => {
  global.fetch = originalFetch;
});

const groqVote = (r: Awaited<ReturnType<typeof factCheck>>) => r.verdicts.find((v) => v.provider === 'groq')!;

describe('an unparseable provider reply is NOT_CHECKED, never a default vote', () => {
  it('cut-off reasoning (finish_reason length, no JSON) is an ERROR, and the lone FALSE cannot veto', async () => {
    groqMessage = { content: '', reasoning: 'We need to check the claim. She starred in "The Good Doctor" as a recurring? Let me' };
    groqFinish = 'length';
    const r = await factCheck('Some claim about an actress.', PROVIDERS);
    expect(groqVote(r)).toMatchObject({ verdict: 'ERROR', error: 'unparseable reply (finish_reason length)' });
    expect(r.families_used).toBe(1);
    expect(r.decision).not.toBe('vetoed');
    expect(r.decision).toBe('flagged');
    // The ledger says the call failed, with the reason.
    const groqLog = (logLlmCall as jest.Mock).mock.calls.map((c) => c[0]).find((e) => e.provider === 'groq');
    expect(groqLog).toMatchObject({ status: 'failed', error_message: 'unparseable reply (finish_reason length)' });
  });

  it('a verdict with no confidence, or an unknown verdict word, is not a vote either', async () => {
    groqMessage = { content: '{"verdict":"FALSE"}' };
    expect(groqVote(await factCheck('c', PROVIDERS)).verdict).toBe('ERROR');
    groqMessage = { content: '{"verdict":"MOSTLY TRUE","confidence":80}' };
    expect(groqVote(await factCheck('c', PROVIDERS)).verdict).toBe('ERROR');
    groqMessage = { content: '{"verdict":"TRUE","confidence":null}' };
    expect(groqVote(await factCheck('c', PROVIDERS)).verdict).toBe('ERROR');
  });

  it('real answers still parse: JSON after reasoning prose, a numeric-string confidence, and broken JSON that states both', async () => {
    groqFinish = 'stop';
    groqMessage = { content: 'Thinking {not json}. Final: {"verdict":"TRUE","confidence":95,"note":"ok"}' };
    expect(groqVote(await factCheck('c', PROVIDERS))).toMatchObject({ verdict: 'TRUE', confidence: 95 });
    groqMessage = { content: '{"verdict":"UNCERTAIN","confidence":"60","note":"plausible"}' };
    expect(groqVote(await factCheck('c', PROVIDERS))).toMatchObject({ verdict: 'UNCERTAIN', confidence: 60 });
    groqMessage = { content: '{"verdict":"FALSE","confidence":90,"note":"the "Good" Doctor"}' };
    expect(groqVote(await factCheck('c', PROVIDERS))).toMatchObject({ verdict: 'FALSE', confidence: 90 });
    // Two real families agreeing FALSE still veto.
    expect((await factCheck('c', PROVIDERS)).decision).toBe('vetoed');
  });
});
