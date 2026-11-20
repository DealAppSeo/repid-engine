/**
 * Regression pins for the "a caught hallucination needs a quorum of FALSE verdicts" rule
 * (HAL_PENALTY_REQUIRES_FALSE_QUORUM, default on). Companion to hal-false-quorum-penalty.test.ts.
 *
 * What this file adds:
 *  - the DECISION WORD and the LEDGER EFFECT are asserted in separate tests over the same inputs, so
 *    one can change without the other test going red for the wrong reason;
 *  - the penalty size is read from computeDelta, not written here as a number;
 *  - a replay is checked against a stateful agent balance (one deduction, not two), and the race the
 *    code cannot see (lookup misses, the database's unique index refuses the insert) is checked too;
 *  - the same 0.5 score can be recorded 'vetoed' or 'flagged': the branch is pinned, with a todo.
 *
 * The REAL chain runs: runScoreEvent -> halService -> factCheck. Only the edges are faked: `fetch`
 * (one canned verdict per model), the provider list, the ground-truth lookup and the database.
 * Every input is made up in this file. No network, no Supabase.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

(global as any)._api_key_versions_table_checked = true;
const G = global as any;
G.__prAgent = null;
G.__prInserts = [];
G.__prAgentWrites = [];
G.__prLookupBlind = false; // true = the idempotency read finds nothing (a concurrent caller got there first)
G.__prInsertError = null; // set = the insert is refused with this error
G.__prGroundTruth = null;

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const g = global as any;
      if (table === 'repid_agents') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: g.__prAgent ? { ...g.__prAgent } : null, error: g.__prAgent ? null : { message: 'nf' } }) }) }),
          // Stateful: a score write really moves the balance the next call reads.
          update: (p: any) => ({ eq: () => { g.__prAgentWrites.push(p); if (typeof p.current_repid === 'number') g.__prAgent.current_repid = p.current_repid; return Promise.resolve({ data: null, error: null }); } }),
        };
      }
      if (table === 'repid_score_events') {
        return {
          select: (_c?: string, o?: any) => {
            const chain = (col: string, val: unknown): any => ({
              eq: () => chain(col, val),
              limit: () => ({
                maybeSingle: async () => ({
                  data: col === 'idempotency_key' && !g.__prLookupBlind ? (g.__prInserts.find((r: any) => r.idempotency_key === val) ?? null) : null,
                  error: null,
                }),
              }),
              then: (r: any) => r({ data: null, error: null, count: o?.head ? 0 : null }),
            });
            return { eq: chain };
          },
          insert: (p: any) => ({ select: () => ({ single: async () => {
            if (g.__prInsertError) return { data: null, error: g.__prInsertError };
            const row = { id: 900 + g.__prInserts.length, ...p };
            g.__prInserts.push(row);
            return { data: { id: row.id }, error: null };
          } }) }),
        };
      }
      return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }), insert: () => Promise.resolve({ data: null, error: null }), update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) };
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

jest.mock('../src/hal/ground-truth-gate', () => ({
  checkGroundTruth: async () => (global as any).__prGroundTruth ?? { verdict: 'no_match', corroborating: [], contradicting: [], reason: 'no match', degraded: false },
}));

jest.mock('../src/hal/fact-check', () => {
  const actual = jest.requireActual('../src/hal/fact-check');
  return {
    ...actual,
    buildFactCheckProvidersWith: () => [
      { name: 'fam-a', endpoint: 'http://provider.test/a', apiKey: 'k', model: 'llama-3.1-8b-instant' },
      { name: 'fam-b', endpoint: 'http://provider.test/b', apiKey: 'k', model: 'deepseek-chat' },
      { name: 'fam-c', endpoint: 'http://provider.test/c', apiKey: 'k', model: 'mistral-small-latest' },
    ],
  };
});

import { runScoreEvent } from '../src/scoring/pipeline';
import { computeDelta } from '../src/scoring/repid-delta';
import { halService } from '../src/hal/service';
import { buildFactCheckProvidersWith } from '../src/hal/fact-check';

const AGENT = '11111111-2222-4333-8444-555555555555';
const START = 1000;
const TIER = 'ESTABLISHED';
const A = 'llama-3.1-8b-instant';
const B = 'deepseek-chat';
const C = 'mistral-small-latest';
const T = { verdict: 'TRUE', confidence: 100 };
const F = { verdict: 'FALSE', confidence: 100 };
const U = { verdict: 'UNCERTAIN', confidence: 100 };
const CORROBORATED = { verdict: 'corroborated', corroborating: [{ fact_key: 'made-up-fact' }], contradicting: [], reason: 'the made-up corpus confirms a value in this claim', degraded: false };

const originalFetch = global.fetch;
const savedEnv = { ...process.env };
let byModel: Record<string, any> = {};

beforeEach(() => {
  process.env = { ...savedEnv };
  process.env.HAL_STRICTNESS = '2';
  process.env.HAL_CONFIG_FROM_DB = 'false';
  process.env.HAL_JEV_PREFILTER_ENABLED = 'false';
  process.env.HAL_SBFA_SHADOW = 'false';
  // The ground-truth gate stays ON (its default): the lookup is the mock above and says no_match unless a case sets it.
  for (const k of ['HAL_GROUND_TRUTH_GATE', 'HAL_PENALTY_REQUIRES_FALSE_QUORUM', 'HAL_PENALTY_REQUIRES_QUORUM', 'HAL_DECISION_REQUIRES_QUORUM',
    'HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION', 'HAL_VERDICT_DRIVEN_VETO', 'HAL_DECISION_MODE', 'HAL_QUORUM_FAMILY_AWARE',
    'HAL_PLURALITY_GUARD', 'HAL_ESCALATE_GROK', 'HAL_RETRIEVAL_ENABLED', 'HAL_SBFA_ENFORCE', 'HAL_VETO_THRESHOLD',
    'HAL_FLAG_THRESHOLD', 'HAL_LOCAL_FALLBACK_ENABLED', 'HAL_SCORE_GATE_MODE', 'WRITER_DIRECT_APPLY', 'LOCAL_LLM_BASE_URL', 'OPENAI_BASE_URL']) {
    delete process.env[k];
  }
  G.__prAgent = { id: AGENT, current_repid: START, tier: TIER, vesting_cliff_ends_at: null };
  G.__prInserts = [];
  G.__prAgentWrites = [];
  G.__prLookupBlind = false;
  G.__prInsertError = null;
  G.__prGroundTruth = null;
  byModel = {};
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    if (!String(url).startsWith('http://provider.test/')) throw new Error(`no network in this test: ${url}`);
    const r = byModel[JSON.parse(init.body).model];
    if (r === undefined) return { ok: false, status: 500, text: async () => 'server error' } as any;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(r) } }] }) } as any;
  });
});
afterAll(() => { global.fetch = originalFetch; process.env = savedEnv; });

let n = 0;
const claim = () => `A made-up claim for this test, number ${++n}.`;
const run = (extra: Record<string, unknown> = {}) =>
  runScoreEvent({ agent_id: AGENT, prompt: 'p', answer: claim(), provider_used: 'deepinfra', ...extra } as any);
const row = () => G.__prInserts[G.__prInserts.length - 1];
const balance = () => G.__prAgent.current_repid as number;

/** What the existing policy charges for a veto on this agent, read from the scorer itself. */
const vetoPenalty = (hal_score: number) =>
  computeDelta({ hal_score, hal_decision: 'vetoed', current_repid: START, agent_tier: TIER, vesting_cliff_active: false }).delta_applied;

type Ledger = 'zero' | 'penalty' | 'not-negative';
const SCENARIOS: Array<{ name: string; arrange: () => void; word: string; ledger: Ledger }> = [
  { name: 'two families UNCERTAIN', arrange: () => { byModel = { [A]: U, [B]: U }; }, word: 'vetoed', ledger: 'zero' },
  { name: 'three families UNCERTAIN', arrange: () => { byModel = { [A]: U, [B]: U, [C]: U }; }, word: 'vetoed', ledger: 'zero' },
  { name: 'two families FALSE', arrange: () => { byModel = { [A]: F, [B]: F }; }, word: 'vetoed', ledger: 'penalty' },
  { name: 'three families UNCERTAIN, corpus corroborates the claim', arrange: () => { byModel = { [A]: U, [B]: U, [C]: U }; G.__prGroundTruth = CORROBORATED; }, word: 'flagged', ledger: 'zero' },
  { name: 'two families TRUE', arrange: () => { byModel = { [A]: T, [B]: T }; }, word: 'clean', ledger: 'not-negative' },
];

describe('the decision word (what a reader of the row is told)', () => {
  test.each(SCENARIOS)('$name -> $word', async ({ arrange, word }) => {
    arrange();
    const r = await run();
    expect(r.hal_decision).toBe(word);
    expect(row().hal_decision).toBe(word);
    expect(row().decision_outcome).toBe(word);
  });
});

describe('the ledger effect (what the agent is charged), asserted without the decision word', () => {
  test.each(SCENARIOS)('$name -> $ledger', async ({ arrange, ledger }) => {
    arrange();
    const r = await run();
    const ins = row();
    if (ledger === 'zero') {
      expect(ins.hallucination_caught).toBe(false);
      expect(ins.delta).toBe(0);
      expect(ins.repid_delta_applied).toBe(0);
      expect(r.repid_delta_applied).toBe(0);
      expect(balance()).toBe(START);
    } else if (ledger === 'penalty') {
      const expected = vetoPenalty(r.hal_score);
      expect(expected).toBeLessThan(0); // the policy does define a deduction for a veto
      expect(ins.hallucination_caught).toBe(true);
      expect(ins.delta).toBe(expected);
      expect(r.repid_delta_applied).toBe(expected);
      expect(balance()).toBe(START + expected);
      expect(ins.metadata.false_quorum_met).toBe(true);
      expect(ins.metadata.suppressed_reason).toBeUndefined();
    } else {
      expect(ins.hallucination_caught).toBe(false);
      expect(ins.delta).toBeGreaterThanOrEqual(0);
      expect(balance()).toBeGreaterThanOrEqual(START);
    }
  });

  test('all UNCERTAIN: the row says what was withheld and why', async () => {
    byModel = { [A]: U, [B]: U, [C]: U };
    const r = await run();
    const ins = row();
    expect(r.hal_score).toBeCloseTo(0.5, 10);
    expect(ins.metadata.false_quorum_count).toBe(0);
    expect(ins.metadata.false_quorum_met).toBe(false);
    expect(ins.metadata.penalty_suppressed).toBe(true);
    expect(ins.metadata.suppressed_reason).toBe('false_quorum_unmet');
    expect(ins.metadata.original_delta).toBe(vetoPenalty(r.hal_score));
  });

  test('all UNCERTAIN on a record-only (shadow) call: nothing is charged and the agent row is not written', async () => {
    byModel = { [A]: U, [B]: U, [C]: U };
    const r = await run({ shadow: { reason: 'made-up-shadow' } });
    const ins = row();
    expect(ins.is_shadow).toBe(true);
    expect(ins.hallucination_caught).toBe(false);
    expect(ins.delta).toBe(0);
    expect(r.repid_delta_applied).toBe(0);
    expect(G.__prAgentWrites).toHaveLength(0);
    expect(balance()).toBe(START);
  });
});

describe('the same event cannot be charged twice', () => {
  test('replay with the same idempotency key: the stored row is returned and the balance moves once', async () => {
    byModel = { [A]: F, [B]: F };
    const first = await run({ idempotency_key: 'pr-replay-1' });
    const afterFirst = balance();
    expect(afterFirst).toBe(START + vetoPenalty(first.hal_score));

    const second = await run({ idempotency_key: 'pr-replay-1' });
    expect(second.idempotent_replay).toBe(true);
    expect(second.score_event_id).toBe(first.score_event_id);
    expect(G.__prInserts).toHaveLength(1);
    expect(G.__prAgentWrites).toHaveLength(1);
    expect(balance()).toBe(afterFirst);
  });

  test('race: the lookup misses and the database refuses the duplicate key -> the call fails before any score write', async () => {
    // The code's own check is read-then-insert, so two concurrent callers can both miss. The backstop is the
    // database's unique index on idempotency_key; this pins what the code does when that index says no.
    byModel = { [A]: F, [B]: F };
    await run({ idempotency_key: 'pr-race-1' });
    const afterFirst = balance();
    expect(afterFirst).toBeLessThan(START);

    G.__prLookupBlind = true;
    G.__prInsertError = { code: '23505', message: 'duplicate key value violates unique constraint (made-up for this test)' };
    await expect(run({ idempotency_key: 'pr-race-1' })).rejects.toThrow(/score event insert failed/);
    expect(G.__prInserts).toHaveLength(1);
    expect(G.__prAgentWrites).toHaveLength(1);
    expect(balance()).toBe(afterFirst);
  });
});

describe('same 0.5 score, two different decision words', () => {
  // Seen on four record-only rows on 2026-11-20: all scored 0.5 with no FALSE answer; two were recorded
  // 'vetoed' and two 'flagged'. The branch: the ground-truth gate lifts a veto to 'clean' when the corpus
  // corroborates a value in the claim; the pipeline then re-derives the word from the score alone, and a
  // 0.5 score that is not vetoed reads as 'flagged'. Neither kind is charged.
  const arrange = () => { byModel = { [A]: U, [B]: U, [C]: U }; };

  test('HAL itself says clean when the corpus corroborates, vetoed when it does not (same answers, same score)', async () => {
    const providersFn = () => (buildFactCheckProvidersWith as any)({});
    arrange();
    const plain = await halService.evaluate({ text: claim(), strictness: 2, providersFn } as any);
    expect(plain.hal_score).toBeCloseTo(0.5, 10);
    expect(plain.decision).toBe('vetoed');

    G.__prGroundTruth = CORROBORATED;
    const lifted = await halService.evaluate({ text: claim(), strictness: 2, providersFn } as any);
    expect(lifted.hal_score).toBeCloseTo(0.5, 10);
    expect(lifted.decision).toBe('clean');
  });

  test('the recorded rows differ in the word and the reason, not in the score, the FALSE count or the charge', async () => {
    arrange();
    const a = await run();
    const vetoed = row();
    G.__prGroundTruth = CORROBORATED;
    const b = await run();
    const flagged = row();

    expect(a.hal_score).toBe(b.hal_score);
    expect([vetoed.hal_decision, flagged.hal_decision]).toEqual(['vetoed', 'flagged']);
    expect(vetoed.metadata.suppressed_reason).toBe('false_quorum_unmet');
    expect(flagged.metadata.suppressed_reason).toBeUndefined();
    expect(flagged.metadata.hal_signals.quorum_note).toBeUndefined(); // no quorum gate fired; the word came from the score
    for (const ins of [vetoed, flagged]) {
      expect(ins.metadata.false_quorum_count).toBe(0);
      expect(ins.hallucination_caught).toBe(false);
      expect(ins.delta).toBe(0);
    }
    expect(balance()).toBe(START);
  });

  // Owner decision, not changed here because it would change live scoring: when the corpus corroborates
  // a claim and HAL returns 'clean', the ledger row says 'flagged' ("unconfirmed") and earns nothing,
  // and the row does not record that the corpus was what lifted the veto.
  test.todo('a corroborated claim is recorded with the word HAL returned, and the row says the corpus lifted the veto');
});
