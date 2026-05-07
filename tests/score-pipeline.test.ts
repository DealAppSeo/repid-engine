/**
 * Sprint A7 — runScoreEvent pipeline tests (Phase 4).
 *
 * Mocks src/db so the pipeline runs end-to-end without touching Supabase.
 */

(global as any)._api_key_versions_table_checked = true;

(global as any).__pipeAgentRow = null;
(global as any).__pipExistingByKey = null;
(global as any).__pipEventCount = 0;
(global as any).__pipInsertCalls = [];
(global as any).__pipUpdateCalls = [];
(global as any).__pipProofQueueCalls = [];
(global as any).__pipForceInsertError = null;

jest.mock('../src/db', () => ({
  db: {
    from: (tableName: string) => {
      if (tableName === 'repid_agents') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: (global as any).__pipAgentRow ?? null,
                error: (global as any).__pipAgentRow ? null : { message: 'not found' },
              }),
            }),
          }),
          update: (payload: any) => ({
            eq: (_col: string, _val: string) => {
              (global as any).__pipUpdateCalls.push(payload);
              return Promise.resolve({ data: null, error: null });
            },
          }),
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
                    data: (global as any).__pipExistingByKey,
                    error: null,
                  }),
                }),
                // Count chain for shouldTriggerProof()
                _count: true,
                then: (resolve: any) =>
                  resolve({
                    data: null,
                    error: null,
                    count: isHead ? (global as any).__pipEventCount ?? 0 : null,
                  }),
              }),
            };
          },
          insert: (payload: any) => ({
            select: () => ({
              single: async () => {
                if ((global as any).__pipForceInsertError) {
                  return { data: null, error: (global as any).__pipForceInsertError };
                }
                (global as any).__pipInsertCalls.push(payload);
                return { data: { id: 12345 }, error: null };
              },
            }),
          }),
        };
      }
      if (tableName === 'repid_proof_queue') {
        return {
          insert: (payload: any) => {
            (global as any).__pipProofQueueCalls.push(payload);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      // Default no-op chain
      return {
        select: () => ({ eq: () => ({ single: async () => ({ data: null, error: null }) }) }),
        insert: () => Promise.resolve({ data: null, error: null }),
        update: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
      };
    },
    rpc: async () => ({ data: null, error: null }),
  },
}));

import { runScoreEvent, NotFoundError } from '../src/scoring/pipeline';

const AGENT_ID = '11111111-2222-4333-8444-555555555555';

beforeEach(() => {
  (global as any).__pipAgentRow = null;
  (global as any).__pipExistingByKey = null;
  (global as any).__pipEventCount = 0;
  (global as any).__pipInsertCalls = [];
  (global as any).__pipUpdateCalls = [];
  (global as any).__pipProofQueueCalls = [];
  (global as any).__pipForceInsertError = null;
});

describe('runScoreEvent', () => {
  test('valid input → returns event_id + new_repid + writes row', async () => {
    (global as any).__pipAgentRow = {
      id: AGENT_ID,
      current_repid: 1000,
      tier: 'EARNING_AUTONOMY',
      vesting_cliff_ends_at: null,
    };

    const result = await runScoreEvent({
      agent_id: AGENT_ID,
      prompt: 'What is 2+2?',
      answer: 'Approximately 4',
      provider_used: 'groq',
      tier_used: '0a',
      model_used: 'llama-3.1-8b-instant',
      llm_call_id: '22222222-2222-4222-8222-222222222222',
    });

    expect(result.score_event_id).toBe(12345);
    expect(result.old_repid).toBe(1000);
    expect(typeof result.hal_score).toBe('number');
    expect(['clean', 'flagged', 'vetoed']).toContain(result.hal_decision);
    expect((global as any).__pipInsertCalls.length).toBe(1);
    expect((global as any).__pipUpdateCalls.length).toBe(1);
    const inserted = (global as any).__pipInsertCalls[0];
    expect(inserted.agent_id).toBe(AGENT_ID);
    expect(inserted.event_type).toBe('HAL_SCORE_EVENT');
    expect(inserted.llm_call_id).toBe('22222222-2222-4222-8222-222222222222');
    expect(inserted.prompt_text).toBe('What is 2+2?');
    expect(inserted.answer_text).toBe('Approximately 4');
  });

  test('idempotency: same key called twice → returns same event_id, no double-write', async () => {
    (global as any).__pipAgentRow = {
      id: AGENT_ID,
      current_repid: 1000,
      tier: 'EARNING_AUTONOMY',
      vesting_cliff_ends_at: null,
    };
    (global as any).__pipExistingByKey = {
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

    const result = await runScoreEvent({
      agent_id: AGENT_ID,
      prompt: 'p',
      answer: 'a',
      idempotency_key: 'dup-key-1',
    });

    expect(result.score_event_id).toBe(99999);
    expect(result.idempotent_replay).toBe(true);
    expect((global as any).__pipInsertCalls.length).toBe(0); // no new write
  });

  test('agent not found → throws NotFoundError', async () => {
    (global as any).__pipAgentRow = null;
    await expect(
      runScoreEvent({ agent_id: AGENT_ID, prompt: 'p', answer: 'a' })
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test('vesting cliff active + low-score answer → delta_applied=0 but event row written', async () => {
    (global as any).__pipAgentRow = {
      id: AGENT_ID,
      current_repid: 1000,
      tier: 'CUSTODIED_DBT',
      vesting_cliff_ends_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
    const result = await runScoreEvent({
      agent_id: AGENT_ID,
      prompt: 'p',
      answer: 'guaranteed certain proof that nothing matters',
      certainty: 0.99,
    });
    // Event row was written regardless.
    expect((global as any).__pipInsertCalls.length).toBe(1);
    expect(result.score_event_id).toBe(12345);
    // If the answer triggered flagged/vetoed, applied should be absorbed to 0.
    if (result.repid_delta_calculated < 0) {
      expect(result.repid_delta_applied).toBe(0);
    }
  });

  test('insert failure → throws (not silent)', async () => {
    (global as any).__pipAgentRow = {
      id: AGENT_ID,
      current_repid: 1000,
      tier: 'EARNING_AUTONOMY',
      vesting_cliff_ends_at: null,
    };
    (global as any).__pipForceInsertError = { message: 'simulated db failure' };
    await expect(
      runScoreEvent({ agent_id: AGENT_ID, prompt: 'p', answer: 'a' })
    ).rejects.toThrow(/simulated db failure/);
  });

  test('row carries hal_decision, hal_signals, prompt_text, answer_text, idempotency_key', async () => {
    (global as any).__pipAgentRow = {
      id: AGENT_ID,
      current_repid: 1000,
      tier: 'EARNING_AUTONOMY',
      vesting_cliff_ends_at: null,
    };
    await runScoreEvent({
      agent_id: AGENT_ID,
      prompt: 'q?',
      answer: 'a!',
      idempotency_key: 'unique-1',
    });
    const inserted = (global as any).__pipInsertCalls[0];
    expect(inserted.hal_decision).toMatch(/clean|flagged|vetoed/);
    expect(inserted.metadata.hal_signals).toBeDefined();
    expect(inserted.idempotency_key).toBe('unique-1');
    expect(typeof inserted.repid_delta_calculated).toBe('number');
    expect(typeof inserted.repid_delta_applied).toBe('number');
  });
});
