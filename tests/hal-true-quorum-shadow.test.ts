/**
 * A reward needs a quorum of TRUE verdicts: SHADOW RECORD ONLY (HAL_TRUE_QUORUM_SHADOW_RECORD).
 *
 * The mirror of hal-false-quorum-penalty.test.ts. A 'clean' decision pays even when no checker said
 * TRUE. The pipeline now WRITES DOWN, beside every reward, whether a quorum of TRUE verdicts (or one of
 * the two evidence paths that can already lift a decision to clean) stood behind it, and what the delta
 * would be if a reward needed that. It must change nothing: there is no enforce path.
 *
 * Groups:
 *  - "unchanged": for every case, the decision word, the hallucination flag, the calculated delta, the
 *    applied delta and the balance are identical with the recording on and off, and the rest of the
 *    row is identical too. This group also passes against a source tree that has no recording at all;
 *    TRUE_QUORUM_DUMP writes the tuples out so the two trees can be compared.
 *  - "shadow fields", "evidence paths", "event replay": what the record says.
 *
 * The REAL chain runs: runScoreEvent -> halService -> factCheck. Only the edges are faked. Every input
 * is made up here. No network, no Supabase. No reward size is written as a number: a reward is
 * "applied == calculated, and positive".
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

(global as any)._api_key_versions_table_checked = true;
const G = global as any;
G.__tqAgent = null;
G.__tqInserts = [];
G.__tqUpdates = [];

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const g = global as any;
      if (table === 'repid_agents') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: g.__tqAgent, error: g.__tqAgent ? null : { message: 'nf' } }) }) }),
          update: (p: any) => ({ eq: () => { g.__tqUpdates.push(p); return Promise.resolve({ data: null, error: null }); } }),
        };
      }
      if (table === 'repid_score_events') {
        return {
          // The idempotency lookup is the one read that must see earlier inserts.
          select: (_c?: string, o?: any) => {
            const chain = (col: string, val: unknown): any => ({
              eq: () => chain(col, val),
              limit: () => ({
                maybeSingle: async () => ({
                  data: col === 'idempotency_key' ? (g.__tqInserts.find((r: any) => r.idempotency_key === val) ?? null) : null,
                  error: null,
                }),
              }),
              then: (r: any) => r({ data: null, error: null, count: o?.head ? 0 : null }),
            });
            return { eq: chain };
          },
          insert: (p: any) => ({ select: () => ({ single: async () => { const row = { id: 900 + g.__tqInserts.length, ...p }; g.__tqInserts.push(row); return { data: { id: row.id }, error: null }; } }) }),
        };
      }
      return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }), insert: () => Promise.resolve({ data: null, error: null }), update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) };
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

// The ground-truth corpus is a table lookup. Off in every case but 10, where this canned answer stands in for it.
G.__tqGroundTruth = null;
jest.mock('../src/hal/ground-truth-gate', () => ({
  checkGroundTruth: async () => (global as any).__tqGroundTruth ?? { verdict: 'no_match', corroborating: [], contradicting: [], reason: 'no match', degraded: false },
}));

// The execution floor runs code. Off in every case but 13, where this canned result stands in for a failed execution.
G.__tqFloor = null;
jest.mock('../src/hal/execution-floor', () => ({
  applyExecutionFloor: async (_text: string, d: any) => (global as any).__tqFloor
    ? { decision: { decision: 'vetoed', decision_reason: 'execution failed' }, overridden: true, note: 'made-up execution failure', floor: { enabled: true } }
    : { decision: d, overridden: false, note: 'not applicable', floor: { enabled: false } },
}));

// The retrieval slow path fetches web pages and grades them. Off in every case but 14 and 15, where these stand in.
G.__tqCrag = null;
jest.mock('../src/hal/retrieval', () => ({ ...jest.requireActual('../src/hal/retrieval'), retrieveEvidence: async () => [{ url: 'https://example.invalid/a', domain: 'a.invalid', text: 'made-up page' }, { url: 'https://example.invalid/b', domain: 'b.invalid', text: 'made-up page' }] }));
jest.mock('../src/hal/crag', () => ({ ...jest.requireActual('../src/hal/crag'), gradeEvidence: async () => (global as any).__tqCrag }));

// Three providers on three different model families. The real builder reads API keys from env.
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

const AGENT = '11111111-2222-4333-8444-555555555555';
const START = 1000;
const A = 'llama-3.1-8b-instant';
const B = 'deepseek-chat';
const C = 'mistral-small-latest';
const T = { verdict: 'TRUE', confidence: 100 };
const F = { verdict: 'FALSE', confidence: 100 };
const U = { verdict: 'UNCERTAIN', confidence: 100 };
const DOWN = 'HTTP500';

const originalFetch = global.fetch;
const savedEnv = { ...process.env };
let byModel: Record<string, any> = {};
let providerCalls = 0;

beforeEach(() => {
  process.env = { ...savedEnv };
  process.env.HAL_STRICTNESS = '2';
  process.env.HAL_CONFIG_FROM_DB = 'false';
  // Deterministic: these two consult a table or a prefilter model, not the three verdicts under test.
  process.env.HAL_GROUND_TRUTH_GATE = 'false';
  process.env.HAL_JEV_PREFILTER_ENABLED = 'false';
  // Shadow telemetry only (it never moves the decision); off so nothing logs after a test ends.
  process.env.HAL_SBFA_SHADOW = 'false';
  for (const k of ['HAL_PENALTY_REQUIRES_FALSE_QUORUM', 'HAL_PENALTY_REQUIRES_QUORUM', 'HAL_DECISION_REQUIRES_QUORUM',
    'HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION', 'HAL_VERDICT_DRIVEN_VETO', 'HAL_DECISION_MODE', 'HAL_QUORUM_FAMILY_AWARE',
    'HAL_PLURALITY_GUARD', 'HAL_ESCALATE_GROK', 'HAL_RETRIEVAL_ENABLED', 'HAL_SBFA_ENFORCE', 'HAL_VETO_THRESHOLD',
    'HAL_FLAG_THRESHOLD', 'HAL_LOCAL_FALLBACK_ENABLED', 'HAL_SCORE_GATE_MODE', 'LOCAL_LLM_BASE_URL', 'OPENAI_BASE_URL']) {
    delete process.env[k];
  }
  G.__tqAgent = { id: AGENT, current_repid: START, tier: 'ESTABLISHED', vesting_cliff_ends_at: null };
  G.__tqInserts = [];
  G.__tqUpdates = [];
  G.__tqGroundTruth = null;
  G.__tqFloor = null;
  G.__tqCrag = null;
  byModel = {};
  providerCalls = 0;
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    if (!String(url).startsWith('http://provider.test/')) throw new Error(`no network in this test: ${url}`);
    providerCalls += 1;
    const r = byModel[JSON.parse(init.body).model];
    if (r === undefined || r === DOWN) return { ok: false, status: 500, text: async () => 'server error' } as any;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(r) } }] }) } as any;
  });
});
afterAll(() => { global.fetch = originalFetch; process.env = savedEnv; });


import * as fs from 'fs';

type Case = { name: string; votes: Record<string, any>; env?: Record<string, string>; groundTruth?: any; crag?: any };
const corpus = (verdict: string) => ({ verdict, corroborating: verdict === 'corroborated' ? [{ id: 'made-up-fact' }] : [], contradicting: [], reason: 'made-up corpus answer', degraded: false });
const crag = (grade: string) => ({ grade, verdict: grade === 'Correct' ? 'TRUE' : 'UNCERTAIN', confidence: 90, grader: 'made-up', corroboration_count: grade === 'Correct' ? 2 : 0, contradiction_count: 0, disclosure_flag: false, reasons: [], graded_sources: [], sources: [] });

// MODEL-VOTE PATH (no evidence path involved).
const VOTE_CASES: Case[] = [
  { name: 'all three TRUE', votes: { [A]: T, [B]: T, [C]: T } },
  { name: 'TRUE quorum met (two TRUE, one UNCERTAIN)', votes: { [A]: T, [B]: T, [C]: U } },
  { name: 'one TRUE only (one TRUE, two UNCERTAIN)', votes: { [A]: T, [B]: U, [C]: U } },
  { name: 'all UNCERTAIN', votes: { [A]: U, [B]: U, [C]: U } },
  { name: 'missing votes (one TRUE, two providers failed)', votes: { [A]: T, [B]: DOWN, [C]: DOWN } },
  { name: 'missing votes (every provider failed)', votes: { [A]: DOWN, [B]: DOWN, [C]: DOWN } },
  { name: 'mixed, below both quorums (one TRUE, one FALSE, one UNCERTAIN)', votes: { [A]: T, [B]: F, [C]: U } },
  { name: 'two FALSE (a penalty row)', votes: { [A]: F, [B]: F } },
  { name: 'one TRUE, one UNCERTAIN (two answered)', votes: { [A]: T, [B]: U, [C]: DOWN } },
  // Thresholds are env knobs; raised here so the panel itself reads three UNCERTAIN answers as 'clean'.
  { name: 'no TRUE at all, thresholds raised', votes: { [A]: U, [B]: U, [C]: U }, env: { HAL_VETO_THRESHOLD: '0.9', HAL_FLAG_THRESHOLD: '0.8' } },
];
// EVIDENCE PATHS that can already lift a decision to clean, each on its own.
const EVIDENCE_CASES: Case[] = [
  { name: 'corpus corroborates, all UNCERTAIN', votes: { [A]: U, [B]: U, [C]: U }, env: { HAL_GROUND_TRUTH_GATE: 'true' }, groundTruth: corpus('corroborated') },
  { name: 'corpus has no match, all UNCERTAIN (control)', votes: { [A]: U, [B]: U, [C]: U }, env: { HAL_GROUND_TRUTH_GATE: 'true' }, groundTruth: null },
  { name: 'retrieval grades Correct, one TRUE two UNCERTAIN', votes: { [A]: T, [B]: U, [C]: U }, env: { HAL_RETRIEVAL_ENABLED: 'true' }, crag: crag('Correct') },
  { name: 'retrieval grades Ambiguous, one TRUE two UNCERTAIN (control)', votes: { [A]: T, [B]: U, [C]: U }, env: { HAL_RETRIEVAL_ENABLED: 'true' }, crag: crag('Ambiguous') },
];
const ALL_CASES = [...VOTE_CASES, ...EVIDENCE_CASES];

const SHADOW_KEYS = ['true_quorum_met', 'true_quorum_count', 'true_quorum_shadow_delta', 'true_quorum_shadow_reason', 'ground_truth_corroborated', 'retrieval_corroborated'];

async function runCase(c: Case, record: 'on' | 'off', key?: string) {
  G.__tqAgent = { id: AGENT, current_repid: START, tier: 'ESTABLISHED', vesting_cliff_ends_at: null };
  if (!key) { G.__tqInserts = []; G.__tqUpdates = []; }
  for (const [k, v] of Object.entries(c.env ?? {})) process.env[k] = v;
  if (record === 'off') process.env.HAL_TRUE_QUORUM_SHADOW_RECORD = 'false'; else delete process.env.HAL_TRUE_QUORUM_SHADOW_RECORD;
  G.__tqGroundTruth = c.groundTruth ?? null;
  G.__tqCrag = c.crag ?? null;
  byModel = c.votes;
  const r: any = await runScoreEvent({ agent_id: AGENT, prompt: 'p', answer: `A made-up claim for the case: ${c.name}.`, provider_used: 'deepinfra', ...(key ? { idempotency_key: key } : {}) });
  const ins = G.__tqInserts[G.__tqInserts.length - 1];
  return { r, ins };
}
const five = (x: { r: any; ins: any }) => ({
  word: x.r.hal_decision, row_word: x.ins.hal_decision, caught: x.ins.hallucination_caught,
  calculated: x.r.repid_delta_calculated, applied: x.r.repid_delta_applied, row_delta: x.ins.delta,
  before: x.ins.repid_before, after: x.ins.repid_after, balance: x.r.new_repid,
});
/** The row without the shadow keys and without wall-clock fields: everything else must not move. */
function rest(ins: any) {
  const strip = (o: any): any => { if (o && typeof o === 'object') { for (const k of Object.keys(o)) { if (/latency|_ms$|_at$|timestamp|^zk_proof_id$/.test(k)) delete o[k]; else strip(o[k]); } } return o; };
  const { metadata, ...cols } = JSON.parse(JSON.stringify(ins));
  for (const k of SHADOW_KEYS) delete metadata[k];
  return { cols: strip(cols), metadata: strip(metadata) };
}

describe('unchanged: the recording moves no word, flag, delta or balance', () => {
  const dump: Record<string, unknown> = {};
  afterAll(() => { if (process.env.TRUE_QUORUM_DUMP) fs.writeFileSync(process.env.TRUE_QUORUM_DUMP, JSON.stringify(dump, null, 1)); });

  test.each(ALL_CASES.map((c) => [c.name, c] as const))('%s', async (_n, c) => {
    const on = await runCase(c, 'on');
    const off = await runCase(c, 'off');
    expect(five(on)).toEqual(five(off));
    expect(rest(on.ins)).toEqual(rest(off.ins));
    for (const k of SHADOW_KEYS) expect(k in off.ins.metadata).toBe(false); // off means nothing is recorded
    // What was written is self-consistent: the ledger moved by exactly the applied delta.
    expect(on.ins.repid_after - on.ins.repid_before).toBe(on.r.repid_delta_applied);
    expect(on.r.new_repid).toBe(START + on.r.repid_delta_applied);
    dump[c.name] = five(on);
  });

  test('the cases cover a reward, a penalty and a zero row (so "identical" is not vacuous)', async () => {
    const applied: number[] = [];
    for (const c of ALL_CASES) applied.push((await runCase(c, 'on')).r.repid_delta_applied);
    expect(applied.some((d) => d > 0)).toBe(true);
    expect(applied.some((d) => d < 0)).toBe(true);
    expect(applied.some((d) => d === 0)).toBe(true);
  });
});

describe('shadow fields: what the record says', () => {
  const paid = (x: { r: any; ins: any }) => {
    expect(x.r.hal_decision).toBe('clean');
    expect(x.r.repid_delta_applied).toBeGreaterThan(0);
    expect(x.r.repid_delta_applied).toBe(Math.round(x.r.repid_delta_calculated));
  };
  const byName = (n: string) => ALL_CASES.find((c) => c.name.startsWith(n))!;

  test('all three TRUE: paid, quorum met, the delta under the rule is the delta paid', async () => {
    const x = await runCase(byName('all three TRUE'), 'on');
    paid(x);
    expect(x.ins.metadata.true_quorum_met).toBe(true);
    expect(x.ins.metadata.true_quorum_count).toBe(3);
    expect(x.ins.metadata.true_quorum_shadow_delta).toBe(x.r.repid_delta_applied);
    expect(x.ins.metadata.true_quorum_shadow_reason).toBeUndefined();
    expect(x.ins.metadata.hal_signals.true_families).toBe(3);
    expect(x.ins.metadata.hal_signals.true_providers).toBe(3);
  });

  test('two TRUE and one UNCERTAIN: paid, quorum met at exactly the minimum', async () => {
    const x = await runCase(byName('TRUE quorum met'), 'on');
    paid(x);
    expect(x.ins.metadata.true_quorum_met).toBe(true);
    expect(x.ins.metadata.true_quorum_count).toBe(2);
    expect(x.ins.metadata.true_quorum_shadow_delta).toBe(x.r.repid_delta_applied);
  });

  test('one TRUE and two UNCERTAIN: PAID today, and the record says the rule would pay nothing', async () => {
    const x = await runCase(byName('one TRUE only'), 'on');
    paid(x); // this is the gap: one voice, a reward
    expect(x.ins.metadata.true_quorum_met).toBe(false);
    expect(x.ins.metadata.true_quorum_count).toBe(1);
    expect(x.ins.metadata.true_quorum_shadow_delta).toBe(0);
    expect(x.ins.metadata.true_quorum_shadow_reason).toBe('true_quorum_unmet');
  });

  test('one TRUE and one UNCERTAIN, two families answered: PAID today, the rule would pay nothing', async () => {
    const x = await runCase(byName('one TRUE, one UNCERTAIN'), 'on');
    paid(x);
    expect(x.ins.metadata.quorum_met).toBe(true); // two families answered...
    expect(x.ins.metadata.true_quorum_met).toBe(false); // ...and one said TRUE
    expect(x.ins.metadata.true_quorum_count).toBe(1);
    expect(x.ins.metadata.true_quorum_shadow_delta).toBe(0);
    expect(x.ins.metadata.true_quorum_shadow_reason).toBe('true_quorum_unmet');
  });

  test('no TRUE at all can not be paid today: even when the panel calls it clean, the pipeline holds the row at flagged', async () => {
    // The pipeline re-reads the risk score, and a score with no TRUE answer in it is never low enough to pay.
    const x = await runCase(byName('no TRUE at all'), 'on');
    expect(x.ins.metadata.extractor_decision).toBeDefined();
    expect(x.r.hal_decision).toBe('flagged');
    expect(x.r.repid_delta_applied).toBe(0);
    expect(x.ins.metadata.true_quorum_count).toBe(0);
    expect(x.ins.metadata.true_quorum_met).toBe(false);
    expect('true_quorum_shadow_delta' in x.ins.metadata).toBe(false);
  });

  test.each(['all UNCERTAIN', 'missing votes (one TRUE', 'missing votes (every', 'mixed, below both', 'two FALSE'])(
    '%s: not paid, so the counts are recorded and no would-be delta is', async (n) => {
      const x = await runCase(byName(n), 'on');
      expect(x.r.repid_delta_applied).toBeLessThanOrEqual(0);
      expect(x.ins.metadata.true_quorum_met).toBe(false);
      expect(typeof x.ins.metadata.true_quorum_count).toBe('number');
      expect('true_quorum_shadow_delta' in x.ins.metadata).toBe(false);
      expect('true_quorum_shadow_reason' in x.ins.metadata).toBe(false);
    });

  test('missing votes: one TRUE answered and two failed counts 1; nobody answering counts 0', async () => {
    expect((await runCase(byName('missing votes (one TRUE'), 'on')).ins.metadata.true_quorum_count).toBe(1);
    expect((await runCase(byName('missing votes (every'), 'on')).ins.metadata.true_quorum_count).toBe(0);
  });

  test('mixed: one TRUE, one FALSE, one UNCERTAIN counts one TRUE and one FALSE, neither a quorum', async () => {
    const x = await runCase(byName('mixed, below both'), 'on');
    expect(x.ins.metadata.true_quorum_count).toBe(1);
    expect(x.ins.metadata.false_quorum_count).toBe(1);
    expect(x.ins.metadata.false_quorum_met).toBe(false);
  });

  test('HAL_QUORUM_FAMILY_AWARE=false counts providers, exactly as the answering quorum does', async () => {
    const x = await runCase({ ...byName('TRUE quorum met'), env: { HAL_QUORUM_FAMILY_AWARE: 'false' } }, 'on');
    expect(x.ins.metadata.true_quorum_count).toBe(x.ins.metadata.hal_signals.true_providers);
    expect(x.ins.metadata.true_quorum_count).toBe(2);
  });

  test('only the exact string false stops the recording', async () => {
    for (const v of ['0', 'off', 'FALSE', '']) {
      process.env.HAL_TRUE_QUORUM_SHADOW_RECORD = v;
      byModel = { [A]: T, [B]: T, [C]: T };
      G.__tqInserts = [];
      await runScoreEvent({ agent_id: AGENT, prompt: 'p', answer: `A made-up claim, switch set to "${v}".`, provider_used: 'deepinfra' });
      expect(G.__tqInserts[0].metadata.true_quorum_met).toBe(true);
    }
  });
});

describe('evidence paths, each apart from the model votes', () => {
  const byName = (n: string) => EVIDENCE_CASES.find((c) => c.name.startsWith(n))!;

  test('corpus corroborates while every model is UNCERTAIN: zero TRUE votes, confirmed by the corpus', async () => {
    const x = await runCase(byName('corpus corroborates'), 'on');
    expect(x.ins.metadata.true_quorum_count).toBe(0);
    expect(x.ins.metadata.ground_truth_corroborated).toBe(true);
    expect(x.ins.metadata.true_quorum_met).toBe(true); // by the corpus, not by votes
    expect(x.ins.metadata.hal_signals.ground_truth_gate.verdict).toBe('corroborated');
    // If this row is paid, the rule would keep paying it; if it is not paid, nothing is claimed.
    if (x.r.repid_delta_applied > 0) expect(x.ins.metadata.true_quorum_shadow_delta).toBe(x.r.repid_delta_applied);
    else expect('true_quorum_shadow_delta' in x.ins.metadata).toBe(false);
    expect(x.ins.metadata.true_quorum_shadow_reason).toBeUndefined();
  });

  test('corpus has no match (control): nothing confirms it', async () => {
    const x = await runCase(byName('corpus has no match'), 'on');
    expect(x.ins.metadata.ground_truth_corroborated).toBeUndefined();
    expect(x.ins.metadata.true_quorum_met).toBe(false);
  });

  test('retrieval grades Correct with one TRUE vote: paid, one vote, confirmed by retrieval', async () => {
    const x = await runCase(byName('retrieval grades Correct'), 'on');
    expect(x.r.hal_decision).toBe('clean');
    expect(x.r.repid_delta_applied).toBeGreaterThan(0);
    expect(x.ins.metadata.true_quorum_count).toBe(1);
    expect(x.ins.metadata.retrieval_corroborated).toBe(true);
    expect(x.ins.metadata.true_quorum_met).toBe(true);
    expect(x.ins.metadata.true_quorum_shadow_delta).toBe(x.r.repid_delta_applied);
  });

  test('retrieval grades Ambiguous (control): one vote is still one vote', async () => {
    const x = await runCase(byName('retrieval grades Ambiguous'), 'on');
    expect(x.ins.metadata.retrieval_corroborated).toBeUndefined();
    expect(x.ins.metadata.true_quorum_met).toBe(false);
    if (x.r.repid_delta_applied > 0) expect(x.ins.metadata.true_quorum_shadow_delta).toBe(0);
  });
});

describe('event replay', () => {
  test('the same idempotency key twice: one row, the shadow fields written once, no delta changes', async () => {
    const c = VOTE_CASES.find((v) => v.name.startsWith('one TRUE only'))!;
    G.__tqInserts = []; G.__tqUpdates = [];
    const first = await runCase(c, 'on', 'tq-replay-1');
    const calls = providerCalls;
    const second = await runCase(c, 'on', 'tq-replay-1');
    expect(G.__tqInserts).toHaveLength(1);
    expect(G.__tqUpdates).toHaveLength(1);
    expect(providerCalls).toBe(calls);
    expect(second.r.idempotent_replay).toBe(true);
    expect(second.r.score_event_id).toBe(first.r.score_event_id);
    expect(second.r.repid_delta_applied).toBe(first.r.repid_delta_applied);
    expect(second.r.new_repid).toBe(first.r.new_repid);
    expect(G.__tqInserts[0].metadata.true_quorum_shadow_reason).toBe('true_quorum_unmet');
    expect(G.__tqInserts[0].metadata.true_quorum_shadow_delta).toBe(0);
    expect(first.r.repid_delta_applied).toBeGreaterThan(0); // and it was still paid in full
  });
});
