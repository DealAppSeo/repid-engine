/**
 * scripts/eval/candidate-voter.ts — evaluating a candidate second voter offline. No test here
 * reaches a real host: the stored baseline stands in for Groq, and fetch is stubbed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

jest.mock('../src/db', () => ({ db: { from: jest.fn(), rpc: jest.fn() } }));

import { __resetVoteCooldowns, castVote, type VoteOutcome, type Voter } from '../src/classify/free-votes';
import {
  askAll,
  candidateProfile,
  FINDINGS_HEADER,
  findingsRow,
  listedModels,
  modelsUrl,
  outcomeOf,
  pairSummary,
  recordingFetch,
  redactHostText,
  STREAK_LIMIT,
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

describe('pairSummary: Groq as stored, paired with the candidate', () => {

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

describe('the hosts Sean named on 2026-10-06 (Workers AI, OpenRouter)', () => {
  const ACCOUNT = 'a'.repeat(32);
  const CF: Voter = { provider: 'workers-ai', model: '@cf/moonshotai/kimi-k2.6' };
  const OR: Voter = { provider: 'openrouter', model: 'meta/muse-spark-1.3' };

  it('Workers AI lists per account through the Cloudflare API, and needs the account id', () => {
    expect(modelsUrl(CF, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT })).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/models/search?per_page=1000`,
    );
    expect(modelsUrl(CF, {})).toBeNull();
    expect(modelsUrl(CF, { CLOUDFLARE_ACCOUNT_ID: '../other' })).toBeNull();
  });

  it('reads Cloudflare\'s { result: [{ name }] } as well as the OpenAI { data: [{ id }] }', async () => {
    const f = jest.fn(async () => new Response(JSON.stringify({ result: [{ name: '@cf/moonshotai/kimi-k2.6' }, { name: null }] }), { status: 200 }));
    expect(await listedModels(CF, 'k', f as unknown as typeof fetch, { CLOUDFLARE_ACCOUNT_ID: ACCOUNT })).toEqual(
      new Set(['@cf/moonshotai/kimi-k2.6']),
    );
  });

  it('OpenRouter lists at /api/v1/models', () => {
    expect(modelsUrl(OR)).toBe('https://openrouter.ai/api/v1/models');
  });
});

describe('every trial is written down the same way', () => {
  it('profiles what the candidate answered, why it abstained, and its median time over answers only', () => {
    const rows = [cand('a', 'TRUE'), cand('b', 'UNSURE'), cand('c', 'FALSE'), { row_id: 'd', outcome: { kind: 'abstain', reason: 'timeout' }, ms: 15000 }] as CandidateRow[];
    rows[0]!.ms = 100;
    rows[1]!.ms = 300;
    rows[2]!.ms = 200;
    expect(candidateProfile(rows)).toEqual({ n: 4, TRUE: 1, FALSE: 1, UNSURE: 1, abstain: 1, abstainWhy: { timeout: 1 }, medianMs: 200 });
  });

  it('a row with abstains says why in its notes', () => {
    const baseline = [base('a', 'TRUE', 'TRUE', 'not-checked'), base('b', 'FALSE', 'FALSE', 'veto')];
    const rows = [cand('a', 'TRUE'), { row_id: 'b', outcome: { kind: 'abstain', reason: 'timeout' }, ms: 15000 }] as CandidateRow[];
    const row = findingsRow('2026-10-06', 'nvidia-nim:example/model-a', pairSummary(baseline, rows), candidateProfile(rows));
    expect(row).toMatch(/abstains: timeout 1 \|$/);
  });

  it('a findings row has one cell per header column, and names both pairs', () => {
    const baseline = [base('a', 'TRUE', 'TRUE', 'not-checked'), base('b', 'FALSE', 'FALSE', 'veto')];
    const rows = [cand('a', 'TRUE'), cand('b', 'FALSE')];
    const row = findingsRow('2026-10-06', 'nvidia-nim:example/model-a', pairSummary(baseline, rows), candidateProfile(rows));
    const cells = (line: string) => line.split('|').length;
    expect(cells(row)).toBe(cells(FINDINGS_HEADER.split('\n')[0]!));
    expect(row).toContain('`nvidia-nim:example/model-a`');
    expect(row).toContain('1 → **2**');
    expect(row).toContain('0 → **0**');
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

describe('askAll: a refusal that never reached the host is not the candidate\'s answer', () => {
  const claims = ['a', 'b', 'c'].map((row_id) => ({ row_id, claim: `claim ${row_id}` }));
  const verdict = (v: 'TRUE' | 'FALSE' | 'UNSURE'): VoteOutcome => ({ kind: 'verdict', verdict: v });
  const abstain = (reason: string) => ({ kind: 'abstain', reason }) as VoteOutcome;
  function harness(outcomes: VoteOutcome[]) {
    const recorded: CandidateRow[] = [];
    const slept: number[] = [];
    const cast = jest.fn(async () => outcomes.shift() ?? verdict('TRUE'));
    return {
      recorded,
      slept,
      cast,
      deps: { cast, record: (r: CandidateRow) => recorded.push(r), sleep: async (ms: number) => void slept.push(ms), clock: () => 0, paceMs: 0, coolMs: 60_000 },
    };
  }

  it('the 2026-10-06 Kimi run: a pause after a failure is waited out and the claim asked again, never recorded', async () => {
    const h = harness([abstain('timeout'), abstain('cooling'), verdict('FALSE'), verdict('TRUE')]);
    const out = await askAll(claims, h.deps);
    expect(out).toEqual({ asked: 3, stopped: null });
    expect(h.recorded.map((r) => (r.outcome.kind === 'verdict' ? r.outcome.verdict : r.outcome.reason))).toEqual(['timeout', 'FALSE', 'TRUE']);
    expect(h.slept).toEqual([61_000]);
    expect(h.cast).toHaveBeenCalledTimes(4);
  });

  it.each(['budget', 'no_key', 'boundary', 'retired_model'])('%s stops the run and records nothing for that claim', async (reason) => {
    const h = harness([verdict('TRUE'), abstain(reason)]);
    const out = await askAll(claims, h.deps);
    expect(out.asked).toBe(1);
    expect(out.stopped).toContain(reason);
    expect(h.recorded).toHaveLength(1);
  });

  it(`stops after ${STREAK_LIMIT} failed calls in a row and says why; a verdict resets the count`, async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ row_id: `r${i}`, claim: 'x' }));
    const seq = [abstain('http_error'), verdict('UNSURE'), ...Array.from({ length: STREAK_LIMIT }, () => abstain('timeout'))];
    const h = harness(seq);
    const out = await askAll(many, h.deps);
    expect(out.asked).toBe(STREAK_LIMIT + 2);
    expect(out.stopped).toBe(`${STREAK_LIMIT} failed calls in a row (timeout ${STREAK_LIMIT})`);
  });

  it('an unparseable reply is the model\'s answer and is recorded', async () => {
    const h = harness([abstain('unparseable')]);
    await askAll(claims.slice(0, 1), h.deps);
    expect(h.recorded[0]!.outcome).toEqual(abstain('unparseable'));
  });
});

describe('what the host said, without a credential', () => {
  it('redacts bearer tokens and key-shaped strings, and caps the length', () => {
    const out = redactHostText(`{"detail":"bad key nvapi-${'x'.repeat(40)}", "h":"Bearer abc.def"}\n${'y'.repeat(500)}`);
    expect(out).not.toMatch(/nvapi-x|abc\.def/);
    expect(out.length).toBeLessThanOrEqual(300);
  });

  it('remembers the first error body per status and passes the response through unread', async () => {
    const seen = new Map<number, string>();
    const inner = jest.fn(async () => new Response('{"detail":"Function not found for account"}', { status: 404 }));
    const res = await recordingFetch(seen, inner as never)('https://example.invalid', {});
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Function not found');
    expect(seen.get(404)).toContain('Function not found');
  });
});
