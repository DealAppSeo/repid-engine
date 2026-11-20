/**
 * The stored signals say when the ground-truth gate matched a claim and what it did to the decision word.
 *
 * Why: with every model UNCERTAIN the score is 0.5 and the decision is 'vetoed'. When the corpus corroborates
 * a value in the claim, the gate lifts that to 'clean', and the scoring pipeline (which re-derives the word
 * from the score) records 'flagged'. Until now nothing on the row said the gate was involved, so a 'flagged'
 * row at 0.5 could not be told from the records alone.
 *
 * Two groups, on purpose:
 *  - SCORING IS UNCHANGED: word, hallucination_caught, every delta and the balance, for inputs with and
 *    without a corpus match. These pass with or without the new field (they pass on the code before it).
 *  - THE RECORD: the new field is present when the corpus matched, absent when it did not, and carries
 *    three words only.
 *
 * The REAL chain runs: runScoreEvent -> halService -> factCheck. Faked: `fetch`, the provider list, the
 * ground-truth lookup and the database. Every input is made up in this file.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

(global as any)._api_key_versions_table_checked = true;
const G = global as any;
G.__gtAgent = null;
G.__gtInserts = [];
G.__gtGroundTruth = null;

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const g = global as any;
      if (table === 'repid_agents') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: g.__gtAgent ? { ...g.__gtAgent } : null, error: g.__gtAgent ? null : { message: 'nf' } }) }) }),
          update: (p: any) => ({ eq: () => { if (typeof p.current_repid === 'number') g.__gtAgent.current_repid = p.current_repid; return Promise.resolve({ data: null, error: null }); } }),
        };
      }
      if (table === 'repid_score_events') {
        return {
          select: (_c?: string, o?: any) => {
            const chain = (): any => ({
              eq: () => chain(),
              limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
              then: (r: any) => r({ data: null, error: null, count: o?.head ? 0 : null }),
            });
            return { eq: chain };
          },
          insert: (p: any) => ({ select: () => ({ single: async () => { const row = { id: 900 + g.__gtInserts.length, ...p }; g.__gtInserts.push(row); return { data: { id: row.id }, error: null }; } }) }),
        };
      }
      return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }), insert: () => Promise.resolve({ data: null, error: null }), update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) };
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

jest.mock('../src/hal/ground-truth-gate', () => ({
  checkGroundTruth: async () => (global as any).__gtGroundTruth ?? { verdict: 'no_match', corroborating: [], contradicting: [], reason: 'no match', degraded: false },
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

const AGENT = '11111111-2222-4333-8444-555555555555';
const START = 1000;
const TIER = 'ESTABLISHED';
const A = 'llama-3.1-8b-instant';
const B = 'deepseek-chat';
const C = 'mistral-small-latest';
const T = { verdict: 'TRUE', confidence: 100 };
const U = { verdict: 'UNCERTAIN', confidence: 100 };
// The made-up corpus hits carry a key and a value, as the real ones do. Neither may reach the new field.
const HIT = { fact_key: 'MADE_UP_FACT_KEY', fact_value: 'MADE-UP-CORPUS-VALUE', category: 'made-up', match_type: 'exact' };
const gt = (verdict: string, degraded = false) => ({
  verdict,
  corroborating: verdict === 'corroborated' ? [HIT] : [],
  contradicting: verdict === 'contradicted' ? [{ ...HIT, match_type: 'wrong_value' }] : [],
  reason: 'made-up reason',
  degraded,
});

const originalFetch = global.fetch;
const savedEnv = { ...process.env };
let byModel: Record<string, any> = {};

beforeEach(() => {
  process.env = { ...savedEnv };
  process.env.HAL_STRICTNESS = '2';
  process.env.HAL_CONFIG_FROM_DB = 'false';
  process.env.HAL_JEV_PREFILTER_ENABLED = 'false';
  process.env.HAL_SBFA_SHADOW = 'false';
  for (const k of ['HAL_GROUND_TRUTH_GATE', 'HAL_PENALTY_REQUIRES_FALSE_QUORUM', 'HAL_PENALTY_REQUIRES_QUORUM', 'HAL_DECISION_REQUIRES_QUORUM',
    'HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION', 'HAL_VERDICT_DRIVEN_VETO', 'HAL_DECISION_MODE', 'HAL_QUORUM_FAMILY_AWARE',
    'HAL_PLURALITY_GUARD', 'HAL_ESCALATE_GROK', 'HAL_RETRIEVAL_ENABLED', 'HAL_SBFA_ENFORCE', 'HAL_VETO_THRESHOLD',
    'HAL_FLAG_THRESHOLD', 'HAL_LOCAL_FALLBACK_ENABLED', 'HAL_SCORE_GATE_MODE', 'WRITER_DIRECT_APPLY', 'LOCAL_LLM_BASE_URL', 'OPENAI_BASE_URL']) {
    delete process.env[k];
  }
  G.__gtAgent = { id: AGENT, current_repid: START, tier: TIER, vesting_cliff_ends_at: null };
  G.__gtInserts = [];
  G.__gtGroundTruth = null;
  byModel = {};
  (global as any).fetch = jest.fn(async (url: string, init: any) => {
    if (!String(url).startsWith('http://provider.test/')) throw new Error(`no network in this test: ${url}`);
    const r = byModel[JSON.parse(init.body).model];
    if (r === undefined) return { ok: false, status: 500, text: async () => 'server error' } as any;
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(r) } }] }) } as any;
  });
});
afterAll(() => { global.fetch = originalFetch; process.env = savedEnv; });

// ONE fixed claim for every run, so two runs differ only in what the corpus said.
const run = () => runScoreEvent({ agent_id: AGENT, prompt: 'p', answer: 'A made-up claim for this test.', provider_used: 'deepinfra' } as any);
const row = () => G.__gtInserts[G.__gtInserts.length - 1];
const delta = (hal_decision: 'vetoed' | 'flagged' | 'clean', hal_score: number) =>
  computeDelta({ hal_score, hal_decision, current_repid: START, agent_tier: TIER, vesting_cliff_active: false });

const allUncertain = () => { byModel = { [A]: U, [B]: U, [C]: U }; };
const allTrue = () => { byModel = { [A]: T, [B]: T, [C]: T }; };

// word = the recorded decision; charged = the delta that lands; gate = what the new field must say (null = absent).
const CASES: Array<{ name: string; arrange: () => void; word: 'vetoed' | 'flagged' | 'clean'; caught: boolean; charged: 'none' | 'as-computed'; gate: null | [string, string, string] }> = [
  { name: 'all UNCERTAIN, corpus says nothing', arrange: () => { allUncertain(); }, word: 'vetoed', caught: false, charged: 'none', gate: null },
  { name: 'all UNCERTAIN, corpus corroborates', arrange: () => { allUncertain(); G.__gtGroundTruth = gt('corroborated'); }, word: 'flagged', caught: false, charged: 'as-computed', gate: ['corroborated', 'vetoed', 'clean'] },
  { name: 'all UNCERTAIN, corpus contradicts', arrange: () => { allUncertain(); G.__gtGroundTruth = gt('contradicted'); }, word: 'vetoed', caught: true, charged: 'as-computed', gate: ['contradicted', 'vetoed', 'vetoed'] },
  { name: 'all UNCERTAIN, corpus lookup degraded', arrange: () => { allUncertain(); G.__gtGroundTruth = gt('corroborated', true); }, word: 'vetoed', caught: false, charged: 'none', gate: null },
  { name: 'all TRUE, corpus says nothing', arrange: () => { allTrue(); }, word: 'clean', caught: false, charged: 'as-computed', gate: null },
  { name: 'all TRUE, corpus corroborates', arrange: () => { allTrue(); G.__gtGroundTruth = gt('corroborated'); }, word: 'clean', caught: false, charged: 'as-computed', gate: ['corroborated', 'clean', 'clean'] },
  { name: 'all TRUE, corpus contradicts', arrange: () => { allTrue(); G.__gtGroundTruth = gt('contradicted'); }, word: 'vetoed', caught: true, charged: 'as-computed', gate: ['contradicted', 'clean', 'vetoed'] },
];

describe('SCORING IS UNCHANGED: word, caught flag, deltas and balance', () => {
  test.each(CASES)('$name -> $word', async ({ arrange, word, caught, charged }) => {
    arrange();
    const r = await run();
    const ins = row();
    const earned = delta(word, r.hal_score);
    const landed = charged === 'none' ? 0 : earned.delta_applied;

    expect(r.hal_decision).toBe(word);
    expect(ins.hal_decision).toBe(word);
    expect(ins.decision_outcome).toBe(word);
    expect(ins.hallucination_caught).toBe(caught);
    expect(ins.repid_delta_calculated).toBe(Math.round(earned.delta_calculated));
    expect(ins.delta).toBe(landed);
    expect(ins.repid_delta_applied).toBe(landed);
    expect(r.repid_delta_applied).toBe(landed);
    expect(ins.repid_before).toBe(START);
    expect(ins.repid_after).toBe(START + landed);
    expect(G.__gtAgent.current_repid).toBe(START + landed);
  });

  test('a corpus match changes nothing on the row except through the decision it already changed', async () => {
    // Same answers, corpus corroborates an already-clean claim: the gate does not move the decision, so the two
    // rows must be identical once the new field is set aside.
    allTrue();
    await run();
    const plain = JSON.parse(JSON.stringify(row()));
    G.__gtAgent.current_repid = START;
    allTrue();
    G.__gtGroundTruth = gt('corroborated');
    await run();
    const matched = JSON.parse(JSON.stringify(row()));
    delete matched.metadata.hal_signals.ground_truth_gate;
    // The TRUE-quorum shadow record names the corpus confirmation too (record-only, like the gate field).
    expect(matched.metadata.ground_truth_corroborated).toBe(true);
    expect(matched.metadata.hal_signals.ground_truth_corroborated).toBe(true);
    delete matched.metadata.ground_truth_corroborated;
    delete matched.metadata.hal_signals.ground_truth_corroborated;
    for (const x of [plain, matched]) { delete x.id; delete x.metadata.hal_signals.latency_ms; delete x.metadata.hal_signals.provider_health; }
    expect(matched).toEqual(plain);
  });
});

describe('THE RECORD: signals say what the ground-truth gate did', () => {
  test.each(CASES)('$name', async ({ arrange, gate }) => {
    arrange();
    const r = await run();
    const stored = row().metadata.hal_signals.ground_truth_gate;
    if (gate === null) {
      expect(stored).toBeUndefined();
      expect((r.signals as any).ground_truth_gate).toBeUndefined();
    } else {
      const expected = { verdict: gate[0], decision_before: gate[1], decision_after: gate[2] };
      expect(stored).toEqual(expected); // exactly these three words, nothing else
      expect((r.signals as any).ground_truth_gate).toEqual(expected);
    }
  });

  test('the two 0.5 rows can now be told apart from the row alone', async () => {
    allUncertain();
    await run();
    const vetoed = row();
    G.__gtAgent.current_repid = START;
    allUncertain();
    G.__gtGroundTruth = gt('corroborated');
    await run();
    const flagged = row();
    expect(vetoed.hal_score).toBe(flagged.hal_score);
    expect([vetoed.hal_decision, flagged.hal_decision]).toEqual(['vetoed', 'flagged']);
    expect(vetoed.metadata.hal_signals.ground_truth_gate).toBeUndefined();
    expect(flagged.metadata.hal_signals.ground_truth_gate).toEqual({ verdict: 'corroborated', decision_before: 'vetoed', decision_after: 'clean' });
  });

  test('the new field holds no fact key, no corpus value and no claim text', async () => {
    allUncertain();
    G.__gtGroundTruth = gt('corroborated');
    await run();
    const text = JSON.stringify(row().metadata.hal_signals.ground_truth_gate);
    expect(text).toBeDefined();
    expect(text).not.toContain('MADE_UP_FACT_KEY');
    expect(text).not.toContain('MADE-UP-CORPUS-VALUE');
    expect(text).not.toContain('made-up reason');
    expect(text).not.toContain('A made-up claim');
  });
});
