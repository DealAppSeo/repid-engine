/**
 * Unit test for proof-drain-service: retry kick-in, stall HITL emit, happy-path drain.
 * Mocks Supabase client + fetch. Placed under tests/ per jest.config.js roots.
 */
import { createProofDrainService } from '../src/services/proof-drain-service';

type Row = { id: string; job_id: string; agent_id: string; event_id: string; status: string };

interface MockSupabaseState {
  pending: Row[];
  scoreById: Record<string, number>;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  hitlInserts: Array<Record<string, unknown>>;
}

function makeMockSupabase(state: MockSupabaseState): any {
  return {
    from(table: string) {
      if (table === 'repid_proof_queue') {
        return {
          select() {
            const chain: any = {
              _filters: {} as Record<string, unknown>,
              eq(col: string, v: unknown) { chain._filters[col] = v; return chain; },
              limit(_n: number) {
                const filtered = state.pending.filter(r =>
                  Object.entries(chain._filters).every(([k, v]) => k === 'zkp_service_url' || (r as any)[k] === v)
                );
                return Promise.resolve({ data: filtered, error: null });
              }
            };
            return chain;
          },
          update(patch: Record<string, unknown>) {
            return {
              eq(_col: string, id: string) {
                state.updates.push({ id, patch });
                return Promise.resolve({ error: null });
              }
            };
          }
        };
      }
      if (table === 'repid_score_events') {
        return {
          select() {
            return {
              eq(_col: string, id: string) {
                return {
                  single() {
                    const score = state.scoreById[id];
                    if (score === undefined) return Promise.resolve({ data: null, error: { message: 'not found' } });
                    return Promise.resolve({ data: { repid_after: score }, error: null });
                  }
                };
              }
            };
          }
        };
      }
      if (table === 'trinity_hitl_requests') {
        return {
          insert(row: Record<string, unknown>) {
            state.hitlInserts.push(row);
            return Promise.resolve({ error: null });
          }
        };
      }
      throw new Error(`unexpected table ${table}`);
    }
  };
}

describe('proof-drain-service', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('happy-path: drains pending job, marks completed', async () => {
    const state: MockSupabaseState = {
      pending: [{ id: 'r1', job_id: 'j1', agent_id: 'a1', event_id: 'e1', status: 'pending' }],
      scoreById: { e1: 1500 },
      updates: [],
      hitlInserts: []
    };
    const supabase = makeMockSupabase(state);
    const fakeFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ commitment: 'commit-abc' }),
      text: async () => ''
    });

    const svc = createProofDrainService({
      supabase,
      zkpServiceUrl: 'http://zkp.test',
      fetchImpl: fakeFetch as any
    });

    const result = await svc.drainOnce();
    expect(result.jobsCompleted).toBe(1);
    expect(result.jobsFailed).toBe(0);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].patch.status).toBe('completed');
    expect(state.updates[0].patch.proof_hash).toBe('commit-abc');
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  test('retries on transient ZKP fetch failure (3 attempts)', async () => {
    const state: MockSupabaseState = {
      pending: [{ id: 'r2', job_id: 'j2', agent_id: 'a2', event_id: 'e2', status: 'pending' }],
      scoreById: { e2: 800 },
      updates: [],
      hitlInserts: []
    };
    const supabase = makeMockSupabase(state);
    const fakeFetch = jest.fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ commitment: 'commit-xyz' }), text: async () => '' });

    const svc = createProofDrainService({
      supabase,
      zkpServiceUrl: 'http://zkp.test',
      fetchImpl: fakeFetch as any
    });

    const promise = svc.drainOnce();
    // advance past 1s + 4s retry delays
    await jest.advanceTimersByTimeAsync(1000);
    await jest.advanceTimersByTimeAsync(4000);
    const result = await promise;

    expect(result.jobsCompleted).toBe(1);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  test('emits stall HITL when queue non-empty and no drain >threshold', async () => {
    jest.useRealTimers();
    const state: MockSupabaseState = {
      pending: [{ id: 'r3', job_id: 'j3', agent_id: 'a3', event_id: 'missing-event', status: 'pending' }],
      scoreById: {},
      updates: [],
      hitlInserts: []
    };
    const supabase = makeMockSupabase(state);
    const fakeFetch = jest.fn();

    const svc = createProofDrainService({
      supabase,
      zkpServiceUrl: 'http://zkp.test',
      stallThresholdMs: 30,
      pollIntervalMs: 5,
      idleSleepMs: 5,
      fetchImpl: fakeFetch as any
    });

    await svc.start();
    await new Promise(r => setTimeout(r, 250));
    await svc.stop();

    expect(state.hitlInserts.length).toBeGreaterThanOrEqual(1);
    const hitl = state.hitlInserts[0];
    expect(hitl.agent_id).toBe('service:proof-drain-worker');
    expect(hitl.reason).toBe('worker_stalled');
    expect((hitl.context as any).queueDepth).toBeGreaterThan(0);
  }, 10000);
});
