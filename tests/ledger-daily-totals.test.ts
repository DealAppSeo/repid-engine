/**
 * Live daily totals (src/ledger/daily-totals.ts): counts only, never text, never on the request path.
 */
import type { VoteOutcome, Voter } from '../src/classify/free-votes';
import {
  __ledgerState,
  __resetLedger,
  engineCommit,
  flush,
  isMissing,
  note,
  pairBucket,
  promptVersion,
  type RpcClient,
} from '../src/ledger/daily-totals';

const GROQ: Voter = { provider: 'groq', model: 'openai/gpt-oss-120b' };
const CEREBRAS: Voter = { provider: 'cerebras', model: 'qwen-3.8-27b' };
const LLAMA: Voter = { provider: 'workers-ai', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' };
const T: VoteOutcome = { kind: 'verdict', verdict: 'TRUE' };
const F: VoteOutcome = { kind: 'verdict', verdict: 'FALSE' };
const U: VoteOutcome = { kind: 'verdict', verdict: 'UNSURE' };
const TIMEOUT: VoteOutcome = { kind: 'abstain', reason: 'timeout' };
const NO_KEY: VoteOutcome = { kind: 'abstain', reason: 'no_key' };
const NOON = Date.parse('2026-10-06T12:00:00Z');
const ENV = { RAILWAY_GIT_COMMIT_SHA: 'abcdef1234567' } as NodeJS.ProcessEnv;

function check(a: [Voter, VoteOutcome], b: [Voter, VoteOutcome], extra: Array<[Voter, VoteOutcome]> = []) {
  note({
    attempts: [a, b, ...extra].map(([voter, outcome]) => ({ voter, outcome })),
    deciders: [a[0], b[0]],
    outcomes: [a[1], b[1]],
    prompt: 'PROMPT v1',
    env: ENV,
    now: () => NOON,
  });
}

function fakeClient(errorFor?: (fn: string) => { code?: string; message?: string } | null) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const client: RpcClient = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      return { error: errorFor ? errorFor(fn) : null };
    },
  };
  return { client, calls };
}

beforeEach(() => __resetLedger());

describe('note: what is counted', () => {
  it('per checker per day: TRUE, FALSE, UNSURE, sent-with-no-answer, not sent', () => {
    check([GROQ, T], [CEREBRAS, F]);
    check([GROQ, U], [CEREBRAS, TIMEOUT], [[LLAMA, NO_KEY]]);
    const rows = __ledgerState().checkers;
    const by = (c: string) => rows.find((r) => r.key.checker === c)!.counts;
    expect(by('groq:openai/gpt-oss-120b')).toEqual({ true_n: 1, false_n: 0, unsure_n: 1, no_answer_n: 0, not_sent_n: 0 });
    expect(by('cerebras:qwen-3.8-27b')).toEqual({ true_n: 0, false_n: 1, unsure_n: 0, no_answer_n: 1, not_sent_n: 0 });
    expect(by('workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toEqual({ true_n: 0, false_n: 0, unsure_n: 0, no_answer_n: 0, not_sent_n: 1 });
    expect(rows[0]!.key).toMatchObject({ day: '2026-10-06', engine_commit: 'abcdef1', prompt_version: promptVersion('PROMPT v1') });
  });

  it('per deciding pair: agreed, contradicted, unsure, incomplete; the pair is order-free', () => {
    check([GROQ, T], [CEREBRAS, T]);
    check([CEREBRAS, F], [GROQ, F]);
    check([GROQ, T], [CEREBRAS, F]);
    check([GROQ, U], [CEREBRAS, F]);
    check([GROQ, U], [CEREBRAS, U]);
    check([GROQ, T], [CEREBRAS, TIMEOUT]);
    const pairs = __ledgerState().pairs;
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.key).toMatchObject({ checker_a: 'cerebras:qwen-3.8-27b', checker_b: 'groq:openai/gpt-oss-120b' });
    expect(pairs[0]!.counts).toEqual({ agreed_true: 1, agreed_false: 1, contradicted: 1, one_unsure: 1, both_unsure: 1, incomplete: 1 });
  });

  it('nothing that is not a name, a verdict word, a day or a version reaches the ledger', () => {
    check([GROQ, T], [CEREBRAS, F]);
    const dump = JSON.stringify(__ledgerState());
    expect(dump).not.toContain('PROMPT v1'); // the prompt is hashed
    for (const k of Object.keys(__ledgerState().checkers[0]!.key)) {
      expect(['day', 'checker', 'prompt_version', 'engine_commit']).toContain(k);
    }
  });

  it('a different prompt is a different measurement', () => {
    expect(promptVersion('a')).not.toBe(promptVersion('b'));
    expect(promptVersion('a')).toHaveLength(10);
  });

  it('engine commit is the short sha, or "unknown"', () => {
    expect(engineCommit(ENV)).toBe('abcdef1');
    expect(engineCommit({} as NodeJS.ProcessEnv)).toBe('unknown');
  });

  it('pairBucket', () => {
    expect(pairBucket(T, T)).toBe('agreed_true');
    expect(pairBucket(F, F)).toBe('agreed_false');
    expect(pairBucket(F, T)).toBe('contradicted');
    expect(pairBucket(U, T)).toBe('one_unsure');
    expect(pairBucket(U, U)).toBe('both_unsure');
    expect(pairBucket(NO_KEY, T)).toBe('incomplete');
  });
});

describe('flush', () => {
  it('sends each row once through the two RPCs, then the map is empty', async () => {
    check([GROQ, T], [CEREBRAS, F]);
    const { client, calls } = fakeClient();
    const r = await flush(client);
    expect(r).toEqual({ sent: 3, failed: 0, inert: false });
    expect(calls.map((c) => c.fn).sort()).toEqual([
      'ledger_bump_checker_daily',
      'ledger_bump_checker_daily',
      'ledger_bump_pair_daily',
    ]);
    const pair = calls.find((c) => c.fn === 'ledger_bump_pair_daily')!.args;
    expect(pair).toMatchObject({ p_day: '2026-10-06', p_contradicted: 1, p_agreed_true: 0 });
    expect(__ledgerState().checkers).toHaveLength(0);
  });

  it('a transient error keeps the counts for the next flush, merged with new ones', async () => {
    check([GROQ, T], [CEREBRAS, T]);
    const failing = fakeClient(() => ({ code: '57014', message: 'timeout' }));
    expect(await flush(failing.client)).toMatchObject({ sent: 0, failed: 3, inert: false });
    check([GROQ, T], [CEREBRAS, T]);
    const ok = fakeClient();
    await flush(ok.client);
    const groq = ok.calls.find((c) => c.args['p_checker'] === 'groq:openai/gpt-oss-120b')!.args;
    expect(groq['p_true']).toBe(2);
  });

  it('a missing function (migration not applied) makes it inert: nothing piles up', async () => {
    check([GROQ, T], [CEREBRAS, T]);
    const missing = fakeClient(() => ({ code: 'PGRST202', message: 'Could not find the function' }));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await flush(missing.client)).inert).toBe(true);
    expect(missing.calls).toHaveLength(1);
    check([GROQ, T], [CEREBRAS, T]);
    expect(__ledgerState().checkers).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('no rpc on the client (local store) is inert, not a crash', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await flush({} as RpcClient)).inert).toBe(true);
    warn.mockRestore();
  });

  it('a throwing client is a failed row, never a throw', async () => {
    check([GROQ, T], [CEREBRAS, T]);
    const client: RpcClient = { rpc: () => Promise.reject(new Error('network')) };
    await expect(flush(client)).resolves.toMatchObject({ failed: 3 });
  });

  it('isMissing: PostgREST and Postgres codes for "not there"', () => {
    expect(isMissing({ code: 'PGRST202' })).toBe(true);
    expect(isMissing({ code: '42883' })).toBe(true);
    expect(isMissing({ code: '42P01' })).toBe(true);
    expect(isMissing({ code: '57014' })).toBe(false);
    expect(isMissing(null)).toBe(false);
  });
});
