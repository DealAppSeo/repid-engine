/**
 * Phase 4 verification test (BACKEND-HARDENING-FOLLOWUP, 2026-05-09).
 *
 * End-to-end test for the runScoreEvent → writeHalEvaluation hook
 * added in commit 16631c6. Calls runScoreEvent with a realistic SDK
 * payload (strictness=1, the path that bypasses classify) and asserts
 * the resulting hal_evaluations row has all the fields we promised
 * Sean it would carry.
 *
 * Mocks supabase end-to-end so this runs without a network call.
 *
 * If this test had existed before MVP-BACKEND-READINESS Phase 3, the
 * runScoreEvent gap would have been caught immediately.
 */

(global as any)._api_key_versions_table_checked = true;

(global as any).__hookAgentRow = null;
(global as any).__hookHalEvalInsert = null;
(global as any).__hookScoreEventInsert = null;
(global as any).__hookExistingByKey = null;
(global as any).__hookHalEvalInsertCount = 0;

jest.mock('../src/db', () => ({
  db: {
    from: (tableName: string) => {
      if (tableName === 'repid_agents') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: (global as any).__hookAgentRow ?? null,
                error: (global as any).__hookAgentRow ? null : { message: 'not found' },
              }),
            }),
          }),
          update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
        };
      }
      if (tableName === 'repid_score_events') {
        return {
          select: (_cols?: string, opts?: any) => {
            const isHead = !!(opts && opts.head);
            return {
              eq: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: (global as any).__hookExistingByKey ?? null,
                    error: null,
                  }),
                }),
                _count: true,
                then: (resolve: any) =>
                  resolve({ data: null, error: null, count: isHead ? 0 : null }),
              }),
            };
          },
          insert: (payload: any) => ({
            select: () => ({
              single: async () => {
                (global as any).__hookScoreEventInsert = payload;
                return { data: { id: 77777 }, error: null };
              },
            }),
          }),
        };
      }
      if (tableName === 'hal_evaluations') {
        return {
          insert: async (payload: any) => {
            (global as any).__hookHalEvalInsert = payload;
            (global as any).__hookHalEvalInsertCount =
              ((global as any).__hookHalEvalInsertCount ?? 0) + 1;
            return { error: null };
          },
        };
      }
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
        insert: () => Promise.resolve({ data: null, error: null }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const API_KEY = 'test-api-key-xyz';
const PROMPT = 'sample prompt text for evaluation';
const EXPECTED_PROMPT_HASH =
  require('crypto').createHash('sha256').update(PROMPT).digest('hex');
const EXPECTED_API_KEY_HASH =
  require('crypto').createHash('sha256').update(API_KEY).digest('hex');

describe('runScoreEvent hal_evaluations hook (Phase 4 verification)', () => {
  let originalFlag: string | undefined;

  beforeAll(() => {
    originalFlag = process.env.HAL_EVALUATIONS_DUAL_WRITE;
    process.env.HAL_EVALUATIONS_DUAL_WRITE = 'true';
  });

  afterAll(() => {
    if (originalFlag === undefined) delete process.env.HAL_EVALUATIONS_DUAL_WRITE;
    else process.env.HAL_EVALUATIONS_DUAL_WRITE = originalFlag;
  });

  beforeEach(() => {
    (global as any).__hookAgentRow = {
      id: AGENT_ID,
      current_repid: 1000,
      tier: 'ESTABLISHED',
      vesting_cliff_ends_at: null,
    };
    (global as any).__hookHalEvalInsert = null;
    (global as any).__hookScoreEventInsert = null;
    (global as any).__hookExistingByKey = null;
    (global as any).__hookHalEvalInsertCount = 0;
  });

  test('SDK-style call writes a hal_evaluations row with all promised fields', async () => {
    // Import inside the test so the mock is active.
    const { runScoreEvent } = require('../src/scoring/pipeline');

    const result = await runScoreEvent({
      agent_id: AGENT_ID,
      prompt: PROMPT,
      answer: 'sample answer text',
      certainty: 0.85,
      provider_used: 'anthropic',
      tier_used: '0a',
      model_used: 'claude-sonnet-4-20250514',
      api_key: API_KEY,
    });

    // Sanity: the score event was inserted (so the hook path was reached).
    expect((global as any).__hookScoreEventInsert).not.toBeNull();
    expect(result.score_event_id).toBe(77777);

    // The hal_evaluations write fired.
    const halEval = (global as any).__hookHalEvalInsert;
    expect(halEval).not.toBeNull();

    // Critical assertions per Phase 4 prompt:
    expect(halEval.mode).toBe('production');
    expect(halEval.agent_id).toBe(AGENT_ID);
    expect(halEval.api_key_hash).toBe(EXPECTED_API_KEY_HASH);
    expect(halEval.api_key).toBeUndefined(); // raw never persisted
    expect(halEval.prompt_text_hash).toBe(EXPECTED_PROMPT_HASH);
    expect(halEval.prompt_text).toBeUndefined(); // raw never persisted
    expect(typeof halEval.hal_score).toBe('number');
    expect(halEval.hal_score).toBeGreaterThanOrEqual(0);
    expect(['APPROVE', 'HITL', 'VETO']).toContain(halEval.decision);
    expect(typeof halEval.repid_engine_commit).toBe('string');
    expect(halEval.repid_engine_commit.length).toBeGreaterThan(0);

    // Provenance / context fields the prompt called for:
    expect(halEval.gen_provider).toBe('anthropic');
    expect(halEval.gen_model).toBe('claude-sonnet-4-20250514');
    expect(halEval.certainty_used).toBe(0.85);
    expect(halEval.prompt_source).toBe('production_traffic');
    expect(typeof halEval.notes).toBe('string');
    expect(halEval.notes).toMatch(/runScoreEvent strictness=1/);
    expect(halEval.notes).toMatch(/score_event_id=77777/);
    expect(typeof halEval.repid_delta).toBe('number');
  });

  test('hook does NOT fire when HAL_EVALUATIONS_DUAL_WRITE is off', async () => {
    process.env.HAL_EVALUATIONS_DUAL_WRITE = 'false';
    const { runScoreEvent } = require('../src/scoring/pipeline');

    await runScoreEvent({
      agent_id: AGENT_ID,
      prompt: PROMPT,
      answer: 'sample',
      api_key: API_KEY,
    });

    expect((global as any).__hookHalEvalInsert).toBeNull();

    // restore for the suite's other tests
    process.env.HAL_EVALUATIONS_DUAL_WRITE = 'true';
  });

  test('hook tolerates absent api_key (route is unauth for v1 alpha)', async () => {
    const { runScoreEvent } = require('../src/scoring/pipeline');

    await runScoreEvent({
      agent_id: AGENT_ID,
      prompt: PROMPT,
      answer: 'sample',
      // api_key omitted
    });

    const halEval = (global as any).__hookHalEvalInsert;
    expect(halEval).not.toBeNull();
    expect(halEval.api_key_hash).toBeUndefined();
    expect(halEval.agent_id).toBe(AGENT_ID); // identity still captured via agent_id
  });

  // Phase 6 — idempotent replay must NOT double-write to hal_evaluations.
  // The early-return in runScoreEvent for an existing idempotency_key
  // happens BEFORE the hook, so a replay must produce zero hal_eval rows.
  test('idempotent replay does not fire the hal_evaluations hook', async () => {
    (global as any).__hookExistingByKey = {
      id: 99999,
      hal_score: 0.2,
      hal_decision: 'clean',
      metadata: { hal_signals: { harm_probability: 0.1 } },
      repid_delta_calculated: 1,
      repid_delta_applied: 1,
      repid_before: 1000,
      repid_after: 1001,
      zk_proof_triggered: false,
      zk_proof_id: null,
    };
    const { runScoreEvent } = require('../src/scoring/pipeline');

    const result = await runScoreEvent({
      agent_id: AGENT_ID,
      prompt: PROMPT,
      answer: 'sample',
      api_key: API_KEY,
      idempotency_key: 'replay-key-1',
    });

    expect(result.idempotent_replay).toBe(true);
    expect(result.score_event_id).toBe(99999);
    expect((global as any).__hookHalEvalInsertCount).toBe(0);
    expect((global as any).__hookHalEvalInsert).toBeNull();
  });

  // Phase 6 — when tier_used is omitted, notes contains 'tier=unknown'
  // (pins the ?? 'unknown' fallback in pipeline.ts).
  test('hook notes carry tier=unknown when tier_used is omitted', async () => {
    const { runScoreEvent } = require('../src/scoring/pipeline');

    await runScoreEvent({
      agent_id: AGENT_ID,
      prompt: PROMPT,
      answer: 'sample',
      // tier_used omitted
    });

    const halEval = (global as any).__hookHalEvalInsert;
    expect(halEval).not.toBeNull();
    expect(halEval.notes).toContain('tier=unknown');
  });
});
