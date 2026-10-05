/**
 * scripts/eval/candidate-voter.ts — evaluating a candidate second voter offline. No test here
 * reaches a real host: the stored baseline stands in for Groq, and fetch is stubbed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('../src/db', () => ({ db: { from: jest.fn(), rpc: jest.fn() } }));

import { __resetVoteCooldowns, castVote, type Voter } from '../src/classify/free-votes';
import {
  listedModels,
  outcomeOf,
  pairSummary,
  type BaselineRow,
  type CandidateRow,
} from '../scripts/eval/candidate-voter';

const ROOT = join(__dirname, '..');
const NIM: Voter = { provider: 'nvidia-nim', model: 'example/model-a' };

function readJsonl<T>(rel: string): T[] {
  return readFileSync(join(ROOT, rel), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

beforeEach(() => __resetVoteCooldowns());

describe('outcomeOf reads a stored reading back as a vote', () => {
  it.each([
    ['TRUE', { kind: 'verdict', verdict: 'TRUE' }],
    ['UNSURE', { kind: 'verdict', verdict: 'UNSURE' }],
    ['abstain:unparseable', { kind: 'abstain', reason: 'unparseable' }],
  ])('%s', (stored, want) => expect(outcomeOf(stored)).toEqual(want));

  it('an ambiguous reading is null, never a guess', () => expect(outcomeOf(null)).toBeNull());
});

describe('pairSummary: Groq as stored, paired with the candidate', () => {
  const base = (row_id: string, truth: 'TRUE' | 'FALSE', groq: string | null, prod: BaselineRow['production_label']): BaselineRow => ({
    row_id,
    label_truth: truth,
    groq_gpt_oss_120b: groq,
    cerebras_qwen_3_8_27b: 'UNSURE',
    production_label: prod,
  });
  const cand = (row_id: string, verdict: 'TRUE' | 'FALSE' | 'UNSURE'): CandidateRow => ({
    row_id,
    outcome: { kind: 'verdict', verdict },
    ms: 1,
  });

  it('applies the agreement rule and counts both kinds of error', () => {
    const baseline = [
      base('a', 'TRUE', 'TRUE', 'not-checked'), // candidate TRUE -> pass, correct
      base('b', 'FALSE', 'FALSE', 'not-checked'), // candidate FALSE -> veto, correct
      base('c', 'FALSE', 'TRUE', 'not-checked'), // candidate TRUE -> pass on a false claim
      base('d', 'TRUE', 'FALSE', 'veto'), // candidate FALSE -> veto on a true claim
      base('e', 'TRUE', 'TRUE', 'pass'), // candidate UNSURE -> not-checked
      base('f', 'TRUE', null, 'pass'), // ambiguous stored Groq reading: skipped
      base('g', 'TRUE', 'TRUE', 'pass'), // candidate not run yet
    ];
    const s = pairSummary(baseline, [cand('a', 'TRUE'), cand('b', 'FALSE'), cand('c', 'TRUE'), cand('d', 'FALSE'), cand('e', 'UNSURE'), cand('f', 'TRUE')]);
    expect(s.groqPlusCandidate).toEqual({ n: 5, decided: 4, correct: 2, falseShownPass: 1, trueShownVeto: 1 });
    expect(s.production).toEqual({ n: 5, decided: 2, correct: 1, falseShownPass: 0, trueShownVeto: 1 });
    expect(s.skippedAmbiguous).toBe(1);
    expect(s.notRunYet).toBe(1);
    expect(s.transitions['not-checked -> pass']).toBe(2);
    expect(s.transitions['pass -> not-checked']).toBe(1);
  });

  it('a candidate that abstains decides nothing', () => {
    const s = pairSummary([base('a', 'TRUE', 'TRUE', 'pass')], [{ row_id: 'a', outcome: { kind: 'abstain', reason: 'timeout' }, ms: 1 }]);
    expect(s.groqPlusCandidate.decided).toBe(0);
  });
});

describe('the stored baseline still matches the corpus it measured', () => {
  const corpus = readJsonl<{ row_id: string; label: string }>('eval/rigorous/rigorous-corpus-v1.jsonl');
  const baseline = readJsonl<BaselineRow>('eval/rigorous/baseline-classify-2026-10-05.jsonl');
  it('one row per corpus claim, same truth label', () => {
    expect(baseline).toHaveLength(corpus.length);
    const truth = new Map(corpus.map((c) => [c.row_id, c.label]));
    for (const b of baseline) expect(truth.get(b.row_id)).toBe(b.label_truth);
  });
});

describe('listedModels: the id must be on the host’s own list', () => {
  it('reads /models next to the chat endpoint, with the key', async () => {
    const f = jest.fn(async () => new Response(JSON.stringify({ data: [{ id: 'example/model-a' }, { id: 7 }] }), { status: 200 }));
    const ids = await listedModels(NIM, 'k', f as unknown as typeof fetch);
    expect(ids).toEqual(new Set(['example/model-a']));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/v1\/models$/);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k');
  });

  it.each([
    ['a 401', async () => new Response('no', { status: 401 })],
    ['a network error', async () => { throw new Error('CONNECT tunnel failed'); }],
  ])('%s is null (NOT_CHECKED), never an empty list', async (_why, impl) => {
    expect(await listedModels(NIM, 'k', jest.fn(impl) as unknown as typeof fetch)).toBeNull();
  });
});

describe('extraBody, for evaluation only', () => {
  function capture() {
    const bodies: Record<string, unknown>[] = [];
    const impl = jest.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'TRUE' } }] }), { status: 200 });
    });
    return { impl, bodies };
  }
  const env = { NVIDIA_NIM_API_KEY: 'test-key-not-real' } as NodeJS.ProcessEnv;

  it('adds its fields, and cannot replace the model, messages, temperature or token cap', async () => {
    const { impl, bodies } = capture();
    const out = await castVote(NIM, 'Paris is in France.', {
      env,
      fetchImpl: impl as never,
      timeoutMs: 500,
      extraBody: { chat_template_kwargs: { thinking: false }, model: 'other/model', max_tokens: 99999, temperature: 1, messages: [] },
    });
    expect(out).toEqual({ kind: 'verdict', verdict: 'TRUE' });
    expect(bodies[0]!.chat_template_kwargs).toEqual({ thinking: false });
    expect(bodies[0]!.model).toBe('example/model-a');
    expect(bodies[0]!.max_tokens).toBe(400);
    expect(bodies[0]!.temperature).toBe(0);
    expect((bodies[0]!.messages as unknown[]).length).toBe(2);
  });

  it('without it the request is exactly what production sends', async () => {
    const { impl, bodies } = capture();
    await castVote(NIM, 'Paris is in France.', { env, fetchImpl: impl as never, timeoutMs: 500 });
    expect(Object.keys(bodies[0]!).sort()).toEqual(['max_tokens', 'messages', 'model', 'temperature']);
  });
});
