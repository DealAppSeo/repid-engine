/**
 * A caught hallucination needs a quorum of FALSE verdicts (HAL_PENALTY_REQUIRES_FALSE_QUORUM).
 *
 * What was wrong: the penalty gate counted families that ANSWERED. An UNCERTAIN answer scores 0.5
 * risk, so three UNCERTAIN answers average exactly the veto threshold: decision 'vetoed', quorum
 * "met", hallucination recorded, score deducted. Nobody had said FALSE.
 *
 * These tests run the REAL chain: runScoreEvent -> halService -> factCheck -> aggregation. Only the
 * edges are faked: `fetch` (one canned verdict per model), the provider list, and the database.
 * No network, no Supabase. Each case asserts the decision AND the ledger row.
 *
 * The exact penalty size is not asserted (it is whatever computeDelta earns): a penalty is
 * "applied == calculated, and negative"; no penalty is "applied is not negative".
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost:54321';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'dummy';

(global as any)._api_key_versions_table_checked = true;
const G = global as any;
G.__fqAgent = null;
G.__fqInserts = [];
G.__fqUpdates = [];

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      const g = global as any;
      if (table === 'repid_agents') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: g.__fqAgent, error: g.__fqAgent ? null : { message: 'nf' } }) }) }),
          update: (p: any) => ({ eq: () => { g.__fqUpdates.push(p); return Promise.resolve({ data: null, error: null }); } }),
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
                  data: col === 'idempotency_key' ? (g.__fqInserts.find((r: any) => r.idempotency_key === val) ?? null) : null,
                  error: null,
                }),
              }),
              then: (r: any) => r({ data: null, error: null, count: o?.head ? 0 : null }),
            });
            return { eq: chain };
          },
          insert: (p: any) => ({ select: () => ({ single: async () => { const row = { id: 900 + g.__fqInserts.length, ...p }; g.__fqInserts.push(row); return { data: { id: row.id }, error: null }; } }) }),
        };
      }
      return { select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }), insert: () => Promise.resolve({ data: null, error: null }), update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) };
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

// The ground-truth corpus is a table lookup. Off in every case but 10, where this canned answer stands in for it.
G.__fqGroundTruth = null;
jest.mock('../src/hal/ground-truth-gate', () => ({
  checkGroundTruth: async () => (global as any).__fqGroundTruth ?? { verdict: 'no_match', corroborating: [], contradicting: [], reason: 'no match', degraded: false },
}));

// The execution floor runs code. Off in every case but 13, where this canned result stands in for a failed execution.
G.__fqFloor = null;
jest.mock('../src/hal/execution-floor', () => ({
  applyExecutionFloor: async (_text: string, d: any) => (global as any).__fqFloor
    ? { decision: { decision: 'vetoed', decision_reason: 'execution failed' }, overridden: true, note: 'made-up execution failure', floor: { enabled: true } }
    : { decision: d, overridden: false, note: 'not applicable', floor: { enabled: false } },
}));

// The retrieval slow path fetches web pages and grades them. Off in every case but 14 and 15, where these stand in.
G.__fqCrag = null;
jest.mock('../src/hal/retrieval', () => ({ ...jest.requireActual('../src/hal/retrieval'), retrieveEvidence: async () => [{ url: 'https://example.invalid/a', domain: 'a.invalid', text: 'made-up page' }, { url: 'https://example.invalid/b', domain: 'b.invalid', text: 'made-up page' }] }));
jest.mock('../src/hal/crag', () => ({ ...jest.requireActual('../src/hal/crag'), gradeEvidence: async () => (global as any).__fqCrag }));

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
  G.__fqAgent = { id: AGENT, current_repid: START, tier: 'ESTABLISHED', vesting_cliff_ends_at: null };
  G.__fqInserts = [];
  G.__fqUpdates = [];
  G.__fqGroundTruth = null;
  G.__fqFloor = null;
  G.__fqCrag = null;
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

let n = 0;
const run = (key?: string) =>
  runScoreEvent({ agent_id: AGENT, prompt: 'p', answer: `The claim under test, number ${++n}.`, provider_used: 'deepinfra', ...(key ? { idempotency_key: key } : {}) });
const row = () => G.__fqInserts[G.__fqInserts.length - 1];

function expectPenalised(r: any) {
  const ins = row();
  expect(r.hal_decision).toBe('vetoed');
  expect(ins.hal_decision).toBe('vetoed');
  expect(ins.hallucination_caught).toBe(true);
  expect(r.repid_delta_calculated).toBeLessThan(0);
  expect(r.repid_delta_applied).toBe(r.repid_delta_calculated);
  expect(ins.delta).toBe(r.repid_delta_calculated);
  expect(r.new_repid).toBe(START + r.repid_delta_calculated);
  expect(ins.metadata.penalty_suppressed).toBe(false);
  expect(ins.metadata.suppressed_reason).toBeUndefined();
}
function expectNotPenalised(r: any) {
  const ins = row();
  expect(ins.hallucination_caught).toBe(false);
  expect(r.repid_delta_applied).toBeGreaterThanOrEqual(0);
  expect(ins.delta).toBeGreaterThanOrEqual(0);
  expect(r.new_repid).toBeGreaterThanOrEqual(START);
}

describe('a caught hallucination needs a quorum of FALSE verdicts', () => {
  test('1. two families TRUE: clean, no deduction, nothing suppressed', async () => {
    byModel = { [A]: T, [B]: T };
    const r = await run();
    expect(r.hal_decision).toBe('clean');
    expectNotPenalised(r);
    const ins = row();
    expect(ins.metadata.quorum_met).toBe(true);
    expect(ins.metadata.false_quorum_count).toBe(0);
    expect(ins.metadata.penalty_suppressed).toBe(false);
    expect(ins.metadata.suppressed_reason).toBeUndefined();
  });

  test('2. two families FALSE: vetoed, hallucination caught, the penalty still applies', async () => {
    byModel = { [A]: F, [B]: F };
    const r = await run();
    expectPenalised(r);
    const ins = row();
    expect(ins.metadata.quorum_met).toBe(true);
    expect(ins.metadata.false_quorum_met).toBe(true);
    expect(ins.metadata.false_quorum_count).toBe(2);
    expect(ins.metadata.hal_signals.false_families).toBe(2);
  });

  test('3. three families UNCERTAIN: still vetoed by score, NOT a caught hallucination, no deduction, marker says why', async () => {
    byModel = { [A]: U, [B]: U, [C]: U };
    const r = await run();
    expect(r.hal_score).toBeCloseTo(0.5, 5);
    expect(r.hal_decision).toBe('vetoed'); // the decision is unchanged; only the penalty is withheld
    expectNotPenalised(r);
    const ins = row();
    expect(ins.hal_decision).toBe('vetoed');
    expect(r.repid_delta_calculated).toBeLessThan(0); // what the veto would have cost
    expect(r.repid_delta_applied).toBe(0);
    expect(r.new_repid).toBe(START);
    expect(ins.metadata.quorum_met).toBe(true); // three families answered...
    expect(ins.metadata.false_quorum_met).toBe(false); // ...and none said FALSE
    expect(ins.metadata.false_quorum_count).toBe(0);
    expect(ins.metadata.penalty_suppressed).toBe(true);
    expect(ins.metadata.suppressed_reason).toBe('false_quorum_unmet');
    expect(ins.metadata.delta_reason).toMatch(/false_quorum_unmet/);
    expect(ins.metadata.original_delta).toBe(r.repid_delta_calculated);
  });

  test('4. one FALSE + two UNCERTAIN: vetoed by score, one FALSE is not a quorum, not penalised', async () => {
    byModel = { [A]: F, [B]: U, [C]: U };
    const r = await run();
    expect(r.hal_score).toBeGreaterThan(0.6);
    expect(r.hal_decision).toBe('vetoed');
    expectNotPenalised(r);
    const ins = row();
    expect(r.repid_delta_applied).toBe(0);
    expect(ins.metadata.false_quorum_count).toBe(1);
    expect(ins.metadata.suppressed_reason).toBe('false_quorum_unmet');
  });

  test('5. two FALSE + one TRUE: the plurality guard leaves the veto (TRUE is the minority), FALSE quorum met, penalised', async () => {
    byModel = { [A]: F, [B]: F, [C]: T };
    const r = await run();
    expectPenalised(r);
    expect(row().metadata.false_quorum_count).toBe(2);
  });

  test('6. only one family answers, and it says FALSE: held at flagged by the low-quorum gate, not penalised', async () => {
    byModel = { [A]: F, [B]: DOWN, [C]: DOWN };
    const r = await run();
    expect(r.hal_decision).toBe('flagged');
    expectNotPenalised(r);
    const ins = row();
    expect(r.repid_delta_applied).toBe(0);
    expect(ins.metadata.quorum_met).toBe(false);
    expect(ins.metadata.quorum_families_used).toBe(1);
    expect(ins.metadata.false_quorum_met).toBe(false);
    // No penalty was ever computed for a 'flagged' decision, so there is nothing to mark suppressed.
    expect(r.repid_delta_calculated).toBe(0);
    expect(ins.metadata.suppressed_reason).toBeUndefined();
  });

  test('7. the same idempotency key twice: one ledger row, one score write, one effect', async () => {
    byModel = { [A]: F, [B]: F };
    const first = await run('fq-replay-1');
    const callsAfterFirst = providerCalls;
    const second = await run('fq-replay-1');
    expect(G.__fqInserts).toHaveLength(1);
    expect(G.__fqUpdates).toHaveLength(1);
    expect(providerCalls).toBe(callsAfterFirst); // the replay did not ask the providers again
    expect(second.idempotent_replay).toBe(true);
    expect(second.score_event_id).toBe(first.score_event_id);
    expect(second.hal_decision).toBe('vetoed');
    expect(second.repid_delta_applied).toBe(first.repid_delta_applied);
    expect(second.new_repid).toBe(first.new_repid);
    expect(first.repid_delta_applied).toBeLessThan(0);
  });

  test('8. rollback switch: HAL_PENALTY_REQUIRES_FALSE_QUORUM=false penalises case 3 as before (control)', async () => {
    process.env.HAL_PENALTY_REQUIRES_FALSE_QUORUM = 'false';
    byModel = { [A]: U, [B]: U, [C]: U };
    const r = await run();
    expectPenalised(r); // the old defect, on purpose: three UNCERTAIN answers cost a penalty
    expect(row().metadata.false_quorum_count).toBe(0);
  });

  test('9. HAL_VERDICT_DRIVEN_VETO=true: case 3 is flagged, and not penalised', async () => {
    process.env.HAL_VERDICT_DRIVEN_VETO = 'true';
    byModel = { [A]: U, [B]: U, [C]: U };
    const r = await run();
    expect(r.hal_decision).toBe('flagged');
    expectNotPenalised(r);
    const ins = row();
    expect(ins.hal_decision).toBe('flagged');
    expect(r.repid_delta_calculated).toBe(0);
    expect(r.repid_delta_applied).toBe(0);
    expect(ins.metadata.hal_signals.quorum_note).toMatch(/no FALSE quorum/);
  });

  test('10. the ground-truth corpus contradicts the claim while every model is UNCERTAIN: still penalised', async () => {
    // The models cannot know an internal fact; the corpus records it. That contradiction is an explicit FALSE
    // finding from a deterministic source, penalised before this rule and still penalised.
    delete process.env.HAL_GROUND_TRUTH_GATE;
    G.__fqGroundTruth = { verdict: 'contradicted', corroborating: [], contradicting: [{ id: 'made-up-fact' }], reason: 'the corpus records a different value', degraded: false };
    byModel = { [A]: U, [B]: U, [C]: U };
    const r = await run();
    expectPenalised(r);
    expect(row().metadata.false_quorum_count).toBe(0);
    expect(row().metadata.ground_truth_contradicted).toBe(true);
  });

  test('12. the ground-truth contradiction is what forces the veto: two TRUE answers alone would be clean', async () => {
    // Control for case 10, where the models already produced a veto: here they would not.
    byModel = { [A]: T, [B]: T };
    const clean = await run();
    expect(clean.hal_decision).toBe('clean');
    delete process.env.HAL_GROUND_TRUTH_GATE;
    G.__fqGroundTruth = { verdict: 'contradicted', corroborating: [], contradicting: [{ id: 'made-up-fact' }], reason: 'the corpus records a different value', degraded: false };
    byModel = { [A]: T, [B]: T };
    const r = await run();
    expectPenalised(r);
    expect(row().metadata.ground_truth_contradicted).toBe(true);
  });

  test('13. the execution floor forces the veto while every model is UNCERTAIN or TRUE: still penalised', async () => {
    // A deterministic execution failure, not an opinion. Penalised before this rule, and still.
    G.__fqFloor = true;
    byModel = { [A]: T, [B]: T };
    const r = await run();
    expectPenalised(r);
    expect(row().metadata.false_quorum_count).toBe(0);
    expect(row().metadata.execution_floor_override).toBe(true);
  });

  const crag = (grade: string) => ({ grade, verdict: grade === 'Incorrect' ? 'FALSE' : 'UNCERTAIN', confidence: 90, grader: 'made-up', corroboration_count: 0, contradiction_count: grade === 'Incorrect' ? 2 : 0, disclosure_flag: false, sources: [] });

  test('14. one FALSE, one TRUE, one UNCERTAIN, and retrieval finds independent sources that contradict: penalised', async () => {
    process.env.HAL_RETRIEVAL_ENABLED = 'true';
    G.__fqCrag = crag('Incorrect');
    byModel = { [A]: F, [B]: T, [C]: U };
    const r = await run();
    expectPenalised(r);
    expect(row().metadata.false_quorum_count).toBe(1);
    expect(row().metadata.retrieval_contradicted).toBe(true);
  });

  test('15. the same answers with an Ambiguous retrieval grade: nobody found it false, so no penalty (control for 14)', async () => {
    process.env.HAL_RETRIEVAL_ENABLED = 'true';
    G.__fqCrag = crag('Ambiguous');
    byModel = { [A]: F, [B]: T, [C]: U };
    const r = await run();
    expectNotPenalised(r);
    expect(row().metadata.retrieval_contradicted).toBeUndefined();
  });

  test('11. a DEGRADED ground-truth lookup is not a contradiction: all UNCERTAIN stays unpenalised', async () => {
    delete process.env.HAL_GROUND_TRUTH_GATE;
    G.__fqGroundTruth = { verdict: 'contradicted', corroborating: [], contradicting: [], reason: 'corpus unreachable', degraded: true };
    byModel = { [A]: U, [B]: U, [C]: U };
    const r = await run();
    expect(r.hal_decision).toBe('vetoed');
    expectNotPenalised(r);
    expect(row().metadata.suppressed_reason).toBe('false_quorum_unmet');
  });
});
