/**
 * HAL_SCORE_GATE_MODE=shadow: the quorum judges every score event beside the live verdict, and the
 * live row, delta and score never change. Gap 2 of the 2026-11-16 E2E eval.
 *
 * Imports ONLY runScoreEvent, which exists on main, so on main this file runs and fails for the
 * real reason (no quorum verdict is recorded) rather than at import.
 *
 * Nothing is stubbed between the score event and the provider HTTP: halService, factCheck, the
 * two-family early stop and the gate chain are the real code. Only the providers' answers (fetch),
 * the provider list, the DB and the cache store are fakes.
 */
(global as any)._api_key_versions_table_checked = true;

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const EIFFEL = 'The Eiffel Tower is in Berlin.';
const WATER = 'Water boils at 100 degrees Celsius at sea level.';

const state = {
  inserts: [] as any[],
  agentUpdates: [] as any[],
  shadowRows: [] as any[],
  shadowInsertError: null as null | { code: string; message: string },
  cache: new Map<string, any>(),
};

jest.mock('../src/db', () => ({
  db: {
    from: (table: string) => {
      if (table === 'repid_agents') {
        return {
          select: () => ({ eq: () => ({ single: async () => ({ data: { id: AGENT_ID, current_repid: 1000, tier: 'ESTABLISHED', vesting_cliff_ends_at: null, activity_30d: 0 }, error: null }) }) }),
          update: (p: any) => ({ eq: async () => { state.agentUpdates.push(p); return { data: null, error: null }; } }),
        };
      }
      if (table === 'repid_score_events') {
        return {
          select: (_c?: string, opts?: any) => ({
            eq: () => ({
              get eq() { return () => this; },
              gte: async () => ({ data: [], error: null }),
              limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
              then: (resolve: any) => resolve({ data: null, error: null, count: opts?.head ? 0 : null }),
            }),
          }),
          insert: (p: any) => ({ select: () => ({ single: async () => { state.inserts.push(p); return { data: { id: 7000 + state.inserts.length }, error: null }; } }) }),
          update: () => ({ eq: async () => ({ data: null, error: null }) }),
        };
      }
      if (table === 'hal_score_gate_shadow') {
        return { insert: async (row: any) => { if (state.shadowInsertError) return { data: null, error: state.shadowInsertError }; state.shadowRows.push(row); return { data: null, error: null }; } };
      }
      if (table === 'repid_config') return { select: () => ({ in: async () => ({ data: [], error: null }) }) };
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }), maybeSingle: async () => ({ data: null, error: null }) }) }),
        insert: () => Promise.resolve({ data: null, error: null }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

jest.mock('../src/cache/hal-cache', () => ({
  getCachedHalResult: async (prompt: string, provider: string) => state.cache.get(`${provider}|${prompt}`) ?? null,
  cacheHalResult: async (prompt: string, provider: string, r: any) => { state.cache.set(`${provider}|${prompt}`, r); },
}));
jest.mock('../src/billing/log-call', () => ({ logLlmCall: jest.fn(async () => undefined) }));
jest.mock('../src/hal/ground-truth-gate', () => ({
  checkGroundTruth: jest.fn(async () => ({ verdict: 'no_match', corroborating: [], contradicting: [], reason: 'mocked', degraded: false })),
}));
// Two independent families on two hosts: the shape the live quorum decides with (groq/gpt-oss + cerebras/qwen).
jest.mock('../src/hal/fact-check', () => {
  const actual = jest.requireActual('../src/hal/fact-check');
  return {
    ...actual,
    buildFactCheckProvidersWith: () => [
      { name: 'groq', endpoint: 'http://groq.test/v1/chat/completions', apiKey: 'test-a', model: 'gpt-oss-test', family: 'openai', tier: 'free' },
      { name: 'cerebras', endpoint: 'http://cerebras.test/v1/chat/completions', apiKey: 'test-b', model: 'qwen-test', family: 'qwen', tier: 'free' },
    ],
  };
});

import { runScoreEvent } from '../src/scoring/pipeline';

/** Every provider answers FALSE for the Eiffel claim and TRUE for the water claim. */
const fetchMock = jest.fn(async (_url: string, init: any) => {
  const content = JSON.stringify(JSON.parse(init.body));
  const verdict = content.includes('Eiffel') ? 'FALSE' : 'TRUE';
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ verdict, confidence: 95 }) } }] }) } as any;
});
const originalFetch = global.fetch;
const ENV_KEYS = ['HAL_SCORE_GATE_MODE', 'HAL_STRICTNESS', 'HAL_CONFIG_FROM_DB'];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => { (global as any).fetch = fetchMock; for (const k of ENV_KEYS) savedEnv[k] = process.env[k]; });
afterAll(() => { global.fetch = originalFetch; for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });
beforeEach(() => {
  state.inserts = []; state.agentUpdates = []; state.shadowRows = []; state.shadowInsertError = null; state.cache.clear();
  fetchMock.mockClear();
  delete process.env.HAL_STRICTNESS; // the code default: the style extractor
  process.env.HAL_CONFIG_FROM_DB = 'false';
  quiet = [jest.spyOn(console, 'log').mockImplementation(() => undefined), jest.spyOn(console, 'warn').mockImplementation(() => undefined)];
});
let quiet: jest.SpyInstance[] = [];
afterEach(() => quiet.forEach((s) => s.mockRestore()));

const run = (answer: string) => runScoreEvent({ agent_id: AGENT_ID, prompt: 'Where is the Eiffel Tower?', answer, task_domain: 'factual' });

/** The detached shadow judgment settles on its own; wait for its row (bounded). */
async function shadowRow(n = 1): Promise<any> {
  for (let i = 0; i < 200 && state.shadowRows.length < n; i++) await new Promise((r) => setImmediate(r));
  return state.shadowRows[n - 1];
}

/** The fields that ARE the live outcome. They must not move when shadow is switched on. */
function liveOutcome(row: any) {
  return {
    delta: row.delta, repid_before: row.repid_before, repid_after: row.repid_after, hal_score: row.hal_score,
    hal_decision: row.hal_decision, hallucination_caught: row.hallucination_caught,
    repid_delta_calculated: row.repid_delta_calculated, repid_delta_applied: row.repid_delta_applied,
    decision_source: row.metadata.decision_source,
  };
}

describe('HAL_SCORE_GATE_MODE=shadow (live path = the extractor default)', () => {
  test('Eiffel-in-Berlin: the quorum VETOes in shadow while the live delta is unchanged', async () => {
    process.env.HAL_SCORE_GATE_MODE = 'off';
    const off = await run(EIFFEL);
    const offRow = state.inserts[0];
    const offRepid = state.agentUpdates[0].current_repid;
    expect(fetchMock).not.toHaveBeenCalled(); // off: no provider is asked anything
    // The defect the eval measured: the extractor neither vetoes nor penalises a plain falsehood.
    expect(off.hal_decision).toBe('flagged');
    expect(off.repid_delta_applied).toBe(0);

    state.inserts = []; state.agentUpdates = [];
    process.env.HAL_SCORE_GATE_MODE = 'shadow';
    const on = await run(EIFFEL);
    const row = await shadowRow();

    expect(liveOutcome(state.inserts[0])).toEqual(liveOutcome(offRow));
    expect(state.agentUpdates[0].current_repid).toBe(offRepid);
    expect(on.repid_delta_applied).toBe(off.repid_delta_applied);

    expect(row).toMatchObject({
      score_event_id: on.score_event_id, mode: 'shadow', live_strictness: 1, live_decision: 'flagged', live_hal_delta: 0,
      quorum_source: 'fresh', quorum_hal_mode: 'fact-check', quorum_raw_decision: 'vetoed', quorum_decision: 'vetoed', quorum_met: true,
      not_checked_reason: null,
    });
    expect(row.quorum_families.sort()).toEqual(['openai', 'qwen']);
    expect(row.quorum_hal_delta).toBeLessThan(0);
    expect(row.live_receipt_id).toMatch(/^halv1_[0-9a-f]{64}$/);
    expect(row.quorum_receipt_id).toMatch(/^halv1_[0-9a-f]{64}$/);
    expect(row.quorum_receipt_id).not.toBe(row.live_receipt_id);
  });

  test('a true claim: the quorum passes it (clean, positive would-be delta) where the extractor flagged it', async () => {
    process.env.HAL_SCORE_GATE_MODE = 'shadow';
    await run(WATER);
    const row = await shadowRow();
    expect(row).toMatchObject({ live_decision: 'flagged', live_hal_delta: 0, quorum_raw_decision: 'clean', quorum_decision: 'clean', quorum_met: true });
    expect(row.quorum_hal_delta).toBeGreaterThan(0);
  });

  test('cost bound: the second event on the same answer is a cache hit and asks no provider', async () => {
    process.env.HAL_SCORE_GATE_MODE = 'shadow';
    await run(EIFFEL);
    await shadowRow(1);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(callsAfterFirst).toBeLessThanOrEqual(2); // one request per enabled provider, at most
    await run(EIFFEL);
    const second = await shadowRow(2);
    expect(second.quorum_source).toBe('cache');
    expect(second.quorum_decision).toBe('vetoed');
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  test('enforce is refused: it behaves as shadow, and the live delta still does not move', async () => {
    process.env.HAL_SCORE_GATE_MODE = 'enforce';
    const r = await run(EIFFEL);
    const row = await shadowRow();
    expect(r.repid_delta_applied).toBe(0);
    expect(row.quorum_decision).toBe('vetoed');
  });

  test('a missing shadow table is loud and leaves the live result alone', async () => {
    process.env.HAL_SCORE_GATE_MODE = 'shadow';
    state.shadowInsertError = { code: 'PGRST205', message: "Could not find the table 'public.hal_score_gate_shadow'" };
    const err = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = await run(EIFFEL);
    for (let i = 0; i < 200 && err.mock.calls.length === 0; i++) await new Promise((res) => setImmediate(res));
    expect(r.repid_delta_applied).toBe(0);
    expect(err.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/shadow row NOT written .*table missing/);
    err.mockRestore();
  });
});

describe('HAL_SCORE_GATE_MODE=shadow (live path already the quorum: HAL_STRICTNESS=2, production today)', () => {
  test('no second quorum call, and the shadow copy of the gate chain agrees with the live delta', async () => {
    process.env.HAL_STRICTNESS = '2';
    process.env.HAL_SCORE_GATE_MODE = 'off';
    const off = await run(EIFFEL);
    const callsOneQuorum = fetchMock.mock.calls.length;
    expect(off.hal_decision).toBe('vetoed');

    fetchMock.mockClear(); state.inserts = [];
    process.env.HAL_SCORE_GATE_MODE = 'shadow';
    const on = await run(EIFFEL);
    const row = await shadowRow();
    expect(fetchMock.mock.calls.length).toBe(callsOneQuorum); // the live quorum only
    expect(on.repid_delta_applied).toBe(off.repid_delta_applied);
    expect(row).toMatchObject({ quorum_source: 'live', live_decision: 'vetoed', quorum_decision: 'vetoed', quorum_met: true });
    expect(row.quorum_hal_delta).toBe(row.live_hal_delta);
    expect(row.live_hal_delta).toBeLessThan(0);
    expect(row.quorum_receipt_id).toBe(row.live_receipt_id);
  });
});
