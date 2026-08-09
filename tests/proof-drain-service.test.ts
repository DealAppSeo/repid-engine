/**
 * Unit test for proof-drain-service: retry kick-in, stall HITL emit, happy-path drain.
 * Mocks Supabase client + fetch. Placed under tests/ per jest.config.js roots.
 */
import { createProofDrainService } from '../src/services/proof-drain-service';
import { ENGINE_LEAF_SCHEME } from '../src/zkp/leaf-dual-write';
import { poseidon2LeafHash } from '../src/zkp/poseidon2-leaf';

type Row = { id: string; job_id: string; agent_id: string; event_id: string; status: string };

interface MockSupabaseState {
  pending: Row[];
  scoreById: Record<string, number>;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  hitlInserts: Array<Record<string, unknown>>;
  // A5 (D-062) optional capture surfaces — undefined in legacy tests (canonical insert
  // then falls through to the "unexpected table" throw, swallowed non-fatally as before).
  zkpInserts?: Array<Record<string, unknown>>;
  agentTier?: string;
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
      // A5 (D-062): only active when a test opts in via state.zkpInserts — legacy tests
      // (without it) keep falling through to the throw below (canonical insert swallowed).
      if (table === 'repid_agents' && state.zkpInserts) {
        const agentRow = { tier: state.agentTier ?? 'ESTABLISHED', agent_name: 'test-agent' };
        return {
          select() { return { eq() { return { maybeSingle() { return Promise.resolve({ data: agentRow, error: null }); } }; } }; }
        };
      }
      if (table === 'repid_zkp_proofs' && state.zkpInserts) {
        return {
          insert(row: Record<string, unknown>) { state.zkpInserts!.push(row); return Promise.resolve({ error: null }); },
          update() { return { eq() { return { eq() { return Promise.resolve({ error: null }); }, is() { return Promise.resolve({ error: null }); } }; } }; }
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
      // PostgREST bypass (2026-05-21): fetchPendingBatch now uses direct pg.
      // Inject a mock pgQuery returning the same pending rows the supabase mock
      // used to serve, so the drain behavior under test is unchanged.
      pgQueryImpl: (async () => state.pending) as any,
      zkpServiceUrl: 'http://zkp.test',
      // routeProofRequest reaches the real `db` singleton (not this mock supabase);
      // stub it so the drain path stays hermetic and never makes a live DB call.
      routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'test-stub' })) as any,
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

  test('A5 flag ON: records prover scheme/proof_bytes/statement into repid_zkp_proofs', async () => {
    const prev = process.env.PROOF_DRAIN_RECORD_REAL_FIELDS;
    process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = 'true';
    try {
      const state: MockSupabaseState = {
        pending: [{ id: 'r9', job_id: 'j9', agent_id: 'a9', event_id: 'e9', status: 'pending' }],
        scoreById: { e9: 2280 },
        updates: [], hitlInserts: [], zkpInserts: [], agentTier: 'ESTABLISHED'
      };
      const supabase = makeMockSupabase(state);
      const fakeFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          commitment: '0xreal', proof_type: 'plonky3_range_check', proof_bytes: 'QkFTRTY0UFJPT0Y=',
          public_statement: 'RepID > 999', repid_score_actual: 2280, tier: 'ESTABLISHED',
          poseidon2_leaf: '0x32ed1341', leaf_scheme: 'poseidon2_babybear'
        }),
        text: async () => ''
      });
      const svc = createProofDrainService({
        supabase,
        pgQueryImpl: (async () => state.pending) as any,
        zkpServiceUrl: 'http://zkp.test',
        routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'test-stub' })) as any,
        fetchImpl: fakeFetch as any
      });
      const result = await svc.drainOnce();
      expect(result.jobsCompleted).toBe(1);
      expect(state.zkpInserts!.length).toBe(1);
      const row = state.zkpInserts![0]!;
      expect(row.scheme).toBe('plonky3_range_check');
      expect(row.proof_bytes).toBe('QkFTRTY0UFJPT0Y=');
      // Corpus hygiene (2026-08-09): the statement is now agent-BOUND — 4 keys, not the
      // old agent-less { repid_score, threshold } shape that produced 7,958 unbound rows.
      // agent_id is the queue row's agent (a9); tier is derived from the proven score
      // (2280 -> ESTABLISHED).
      expect(row.statement).toEqual({
        agent_id: 'a9',
        tier: 'ESTABLISHED',
        repid_score: 2280,
        threshold: 999,
      });
      // B-2 (Inv-1): aggregation-ready leaf + lineage tag recorded under the same flag.
      expect(row.poseidon2_leaf).toBe('0x32ed1341');
      expect(row.leaf_scheme).toBe('poseidon2_babybear');
    } finally {
      if (prev === undefined) delete process.env.PROOF_DRAIN_RECORD_REAL_FIELDS;
      else process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = prev;
    }
  });

  test('A5 flag OFF (default): canonical insert omits scheme/proof_bytes/statement', async () => {
    const prev = process.env.PROOF_DRAIN_RECORD_REAL_FIELDS;
    delete process.env.PROOF_DRAIN_RECORD_REAL_FIELDS;
    try {
      const state: MockSupabaseState = {
        pending: [{ id: 'r10', job_id: 'j10', agent_id: 'a10', event_id: 'e10', status: 'pending' }],
        scoreById: { e10: 2280 },
        updates: [], hitlInserts: [], zkpInserts: [], agentTier: 'ESTABLISHED'
      };
      const supabase = makeMockSupabase(state);
      const fakeFetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          commitment: '0xreal', proof_type: 'plonky3_range_check', proof_bytes: 'QkFTRTY0',
          public_statement: 'RepID > 999', repid_score_actual: 2280, tier: 'ESTABLISHED',
          poseidon2_leaf: '0x32ed1341', leaf_scheme: 'poseidon2_babybear'
        }),
        text: async () => ''
      });
      const svc = createProofDrainService({
        supabase,
        pgQueryImpl: (async () => state.pending) as any,
        zkpServiceUrl: 'http://zkp.test',
        routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'test-stub' })) as any,
        fetchImpl: fakeFetch as any
      });
      await svc.drainOnce();
      expect(state.zkpInserts!.length).toBe(1);
      const row = state.zkpInserts![0]!;
      expect(row.scheme).toBeUndefined();
      expect(row.proof_bytes).toBeUndefined();
      expect(row.statement).toBeUndefined();
      // B-2 (Inv-1): leaf fields are gated by the SAME flag — omitted when OFF.
      expect(row.poseidon2_leaf).toBeUndefined();
      expect(row.leaf_scheme).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.PROOF_DRAIN_RECORD_REAL_FIELDS;
      else process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = prev;
    }
  });

  // --- backlog 4.2: engine-derived Poseidon2 leaf when the prover doesn't send one ---
  // The deployed prover has NEVER emitted poseidon2_leaf ([V 2026-07-26]: non-null on
  // 0 of 78,783 rows), so the A5 pipe above has always carried null in production. These
  // two tests cover the path that actually fires.

  async function drainWithProver(
    proverJson: Record<string, unknown>,
    id: string
  ): Promise<Record<string, unknown>> {
    const state: MockSupabaseState = {
      pending: [{ id, job_id: `j-${id}`, agent_id: `a-${id}`, event_id: `e-${id}`, status: 'pending' }],
      scoreById: { [`e-${id}`]: 2280 },
      updates: [], hitlInserts: [], zkpInserts: [], agentTier: 'ESTABLISHED'
    };
    const svc = createProofDrainService({
      supabase: makeMockSupabase(state),
      pgQueryImpl: (async () => state.pending) as any,
      zkpServiceUrl: 'http://zkp.test',
      routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'test-stub' })) as any,
      fetchImpl: jest.fn().mockResolvedValue({ ok: true, json: async () => proverJson, text: async () => '' }) as any
    });
    await svc.drainOnce();
    expect(state.zkpInserts!.length).toBe(1);
    return state.zkpInserts![0]!;
  }

  const PROVER_WITHOUT_LEAF = {
    commitment: '0xreal', proof_type: 'plonky3_range_check', proof_bytes: 'QkFTRTY0',
    public_statement: 'RepID > 999', repid_score_actual: 2280, tier: 'ESTABLISHED'
  };

  test('4.2 dual-write ON: engine derives the leaf over the ACTUAL stored zk_commitment', async () => {
    const prevA5 = process.env.PROOF_DRAIN_RECORD_REAL_FIELDS;
    const prevDW = process.env.POSEIDON2_LEAF_DUAL_WRITE;
    process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = 'true';
    process.env.POSEIDON2_LEAF_DUAL_WRITE = 'on';
    try {
      const row = await drainWithProver(PROVER_WITHOUT_LEAF, 'r42on');
      // The invariant that makes the column foldable: the stored leaf is the Poseidon2
      // merkle leaf OF THE STORED COMMITMENT — not of the prover's raw commitment, and
      // not of some other string. zk_commitment is nonce-bound, so this can only pass if
      // the leaf was taken after the canonical commitment was built.
      expect(typeof row.zk_commitment).toBe('string');
      expect(row.poseidon2_leaf).toBe(poseidon2LeafHash(row.zk_commitment as string));
      expect(row.leaf_scheme).toBe(ENGINE_LEAF_SCHEME);
      // The primary is untouched — still the sha256 commitment family, not the leaf.
      expect(row.zk_commitment).not.toBe(row.poseidon2_leaf);
      expect(row.zk_commitment).toMatch(/^0x[0-9a-f]{64}$/);
    } finally {
      if (prevA5 === undefined) delete process.env.PROOF_DRAIN_RECORD_REAL_FIELDS;
      else process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = prevA5;
      if (prevDW === undefined) delete process.env.POSEIDON2_LEAF_DUAL_WRITE;
      else process.env.POSEIDON2_LEAF_DUAL_WRITE = prevDW;
    }
  });

  test('4.2 dual-write unset (deployed default): no leaf is written even with A5 ON', async () => {
    const prevA5 = process.env.PROOF_DRAIN_RECORD_REAL_FIELDS;
    const prevDW = process.env.POSEIDON2_LEAF_DUAL_WRITE;
    process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = 'true';
    delete process.env.POSEIDON2_LEAF_DUAL_WRITE;
    try {
      const row = await drainWithProver(PROVER_WITHOUT_LEAF, 'r42off');
      expect(row.scheme).toBe('plonky3_range_check'); // A5 still records what it always did
      expect(row.poseidon2_leaf).toBeUndefined();     // 4.2 adds nothing until enabled
      expect(row.leaf_scheme).toBeUndefined();
    } finally {
      if (prevA5 === undefined) delete process.env.PROOF_DRAIN_RECORD_REAL_FIELDS;
      else process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = prevA5;
      if (prevDW === undefined) delete process.env.POSEIDON2_LEAF_DUAL_WRITE;
      else process.env.POSEIDON2_LEAF_DUAL_WRITE = prevDW;
    }
  });

  test('corpus hygiene: an agent-less job fails closed — no unbound proof is minted', async () => {
    // The exact pollution source: a plonky3 proof whose queue row carries no agent_id.
    // buildBoundStatement must throw, drainOnce must mark the job failed, and NOTHING
    // may be inserted into repid_zkp_proofs.
    const prev = process.env.PROOF_DRAIN_RECORD_REAL_FIELDS;
    process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = 'true';
    try {
      const state: MockSupabaseState = {
        pending: [{ id: 'rNULL', job_id: 'jNULL', agent_id: '', event_id: 'eNULL', status: 'pending' }],
        scoreById: { eNULL: 2280 },
        updates: [], hitlInserts: [], zkpInserts: [], agentTier: 'ESTABLISHED'
      };
      const svc = createProofDrainService({
        supabase: makeMockSupabase(state),
        pgQueryImpl: (async () => state.pending) as any,
        zkpServiceUrl: 'http://zkp.test',
        routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'test-stub' })) as any,
        fetchImpl: jest.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            commitment: '0xreal', proof_type: 'plonky3_range_check', proof_bytes: 'QkFTRTY0',
            public_statement: 'RepID > 999', repid_score_actual: 2280, tier: 'ESTABLISHED'
          }),
          text: async () => ''
        }) as any
      });

      const result = await svc.drainOnce();
      expect(result.jobsCompleted).toBe(0);
      expect(result.jobsFailed).toBe(1);
      // No canonical proof row was written for the agent-less job.
      expect(state.zkpInserts!.length).toBe(0);
      // The queue row was marked failed, not completed.
      const failedPatch = state.updates.find(u => u.id === 'rNULL')?.patch;
      expect(failedPatch?.status).toBe('failed');
    } finally {
      if (prev === undefined) delete process.env.PROOF_DRAIN_RECORD_REAL_FIELDS;
      else process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = prev;
    }
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
      // PostgREST bypass (2026-05-21): fetchPendingBatch now uses direct pg.
      // Inject a mock pgQuery returning the same pending rows the supabase mock
      // used to serve, so the drain behavior under test is unchanged.
      pgQueryImpl: (async () => state.pending) as any,
      zkpServiceUrl: 'http://zkp.test',
      // routeProofRequest reaches the real `db` singleton (not this mock supabase);
      // stub it so the drain path stays hermetic and never makes a live DB call.
      routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'test-stub' })) as any,
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
      // PostgREST bypass (2026-05-21): fetchPendingBatch now uses direct pg.
      // Inject a mock pgQuery returning the same pending rows the supabase mock
      // used to serve, so the drain behavior under test is unchanged.
      pgQueryImpl: (async () => state.pending) as any,
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

  // W1 (RULE-8): a prover that never responds must NOT wedge the drain. Each prover call
  // is bounded by PROOF_DRAIN_PROVER_TIMEOUT_MS; on timeout it aborts → withRetry retries →
  // the job is marked failed and drainOnce RESOLVES (instead of hanging forever, the stall
  // that froze all proofs at 2026-06-07 09:58).
  test('W1: hung prover call times out and does not wedge the drain', async () => {
    const prev = process.env.PROOF_DRAIN_PROVER_TIMEOUT_MS;
    process.env.PROOF_DRAIN_PROVER_TIMEOUT_MS = '50';
    try {
      const state: MockSupabaseState = {
        pending: [{ id: 'r1', job_id: 'j1', agent_id: 'a1', event_id: 'e1', status: 'pending' }],
        scoreById: { e1: 1500 },
        updates: [],
        hitlInserts: []
      };
      const supabase = makeMockSupabase(state);
      // A prover that never answers — only settles by rejecting when its AbortSignal fires.
      const hungFetch = jest.fn((_url: string, opts: any) => new Promise((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
          });
        }
      }));

      const svc = createProofDrainService({
        supabase,
        pgQueryImpl: (async () => state.pending) as any,
        zkpServiceUrl: 'http://zkp.test',
        routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'test-stub' })) as any,
        fetchImpl: hungFetch as any
      });

      const p = svc.drainOnce();
      // Drive the per-attempt 50ms timeouts + the 1s/4s/16s/64s retry backoffs.
      await jest.advanceTimersByTimeAsync(90_000);
      const result = await p;

      expect(result.jobsFailed).toBe(1);
      expect(result.jobsCompleted).toBe(0);
      // 5 bounded attempts were made (MAX_RETRY_ATTEMPTS) — none hung.
      expect(hungFetch).toHaveBeenCalledTimes(5);
      // job was marked failed (not left dangling).
      expect(state.updates.some(u => u.id === 'r1' && (u.patch as any).status === 'failed')).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.PROOF_DRAIN_PROVER_TIMEOUT_MS;
      else process.env.PROOF_DRAIN_PROVER_TIMEOUT_MS = prev;
    }
  }, 15000);
});
