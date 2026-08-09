/**
 * REGRESSION LOCK — proof-statement credibility (Lane A2).
 *
 * THE CONCERN THIS LOCKS
 * ----------------------
 * The ZK proof's public STATEMENT commits to {repid_score, threshold} (and, in
 * the four-key form, {agent_id, tier, repid_score, threshold}). If the
 * `repid_score` embedded in that statement were a HARD-CODED constant (the
 * hypothesis named a literal `1000`) instead of the agent's LIVE score, every
 * proof would attest a fake number and the whole reputation-proof surface would
 * be non-credible.
 *
 * WHAT THE CODE ACTUALLY DOES (verified by reading, locked here)
 * -------------------------------------------------------------
 * `proof-drain-service.processJob()`:
 *   - `score = fetchScore(event_id)` reads the LIVE `repid_score_events.repid_after`.
 *   - the stored statement's `repid_score` is
 *       `proof.repid_score_actual ?? score`
 *     (the prover's server-side actual, else the live score) — never a constant.
 *     (src/services/proof-drain-service.ts:601-607)
 *
 * These tests drive a SYNTHETIC agent whose live score is 222 and assert the
 * statement carries 222 — on BOTH the prover-actual path and the live-score
 * fallback path — and is never 1000. All ids are synthetic (00000000-… / a-…);
 * no production rows are used.
 */
import { createProofDrainService } from '../src/services/proof-drain-service';

type Row = { id: string; job_id: string; agent_id: string; event_id: string; status: string };

interface MockState {
  pending: Row[];
  scoreById: Record<string, number>;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  hitlInserts: Array<Record<string, unknown>>;
  zkpInserts: Array<Record<string, unknown>>;
  agentTier: string;
}

function makeMockSupabase(state: MockState): any {
  return {
    from(table: string) {
      if (table === 'repid_proof_queue') {
        return {
          select() {
            const chain: any = {
              _f: {} as Record<string, unknown>,
              eq(col: string, v: unknown) { chain._f[col] = v; return chain; },
              limit() {
                const filtered = state.pending.filter(r =>
                  Object.entries(chain._f).every(([k, v]) => k === 'zkp_service_url' || (r as any)[k] === v));
                return Promise.resolve({ data: filtered, error: null });
              }
            };
            return chain;
          },
          update(patch: Record<string, unknown>) {
            return { eq(_c: string, id: string) { state.updates.push({ id, patch }); return Promise.resolve({ error: null }); } };
          }
        };
      }
      if (table === 'repid_score_events') {
        return {
          select() {
            return {
              eq(_c: string, id: string) {
                return {
                  single() {
                    const s = state.scoreById[id];
                    if (s === undefined) return Promise.resolve({ data: null, error: { message: 'not found' } });
                    return Promise.resolve({ data: { repid_after: s }, error: null });
                  }
                };
              }
            };
          }
        };
      }
      if (table === 'trinity_hitl_requests') {
        return { insert(row: Record<string, unknown>) { state.hitlInserts.push(row); return Promise.resolve({ error: null }); } };
      }
      if (table === 'repid_agents') {
        const agentRow = { tier: state.agentTier, agent_name: 'synthetic-agent' };
        return { select() { return { eq() { return { maybeSingle() { return Promise.resolve({ data: agentRow, error: null }); } }; } }; } };
      }
      if (table === 'repid_zkp_proofs') {
        return {
          insert(row: Record<string, unknown>) { state.zkpInserts.push(row); return Promise.resolve({ error: null }); },
          update() { return { eq() { return { eq() { return Promise.resolve({ error: null }); }, is() { return Promise.resolve({ error: null }); } }; } }; }
        };
      }
      throw new Error(`unexpected table ${table}`);
    }
  };
}

/**
 * Drain one synthetic job whose LIVE score (repid_score_events.repid_after) is
 * `liveScore`, against a prover returning `proverJson`. Returns the row that
 * would be inserted into repid_zkp_proofs (the canonical proof artifact).
 * PROOF_DRAIN_RECORD_REAL_FIELDS is forced ON so the statement is recorded.
 */
async function drainOneRecordingStatement(liveScore: number, proverJson: Record<string, unknown>): Promise<Record<string, unknown>> {
  const prev = process.env.PROOF_DRAIN_RECORD_REAL_FIELDS;
  process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = 'true';
  try {
    const state: MockState = {
      pending: [{ id: 'r-222', job_id: 'j-222', agent_id: '00000000-0000-0000-0000-000000000222', event_id: 'e-222', status: 'pending' }],
      scoreById: { 'e-222': liveScore },
      updates: [], hitlInserts: [], zkpInserts: [], agentTier: 'PROBATIONARY',
    };
    const svc = createProofDrainService({
      supabase: makeMockSupabase(state),
      pgQueryImpl: (async () => state.pending) as any,
      zkpServiceUrl: 'http://zkp.test',
      routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'test-stub' })) as any,
      fetchImpl: jest.fn().mockResolvedValue({ ok: true, json: async () => proverJson, text: async () => '' }) as any,
    });
    const result = await svc.drainOnce();
    expect(result.jobsCompleted).toBe(1);
    expect(state.zkpInserts.length).toBe(1);
    // The live score is what was POSTed to the prover (proves the wiring reads live, not a constant).
    return state.zkpInserts[0]!;
  } finally {
    if (prev === undefined) delete process.env.PROOF_DRAIN_RECORD_REAL_FIELDS;
    else process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = prev;
  }
}

describe('proof-statement carries the LIVE score, never a hard-coded constant', () => {
  test('prover-actual path: statement.repid_score == the synthetic live score 222 (not 1000)', async () => {
    const row = await drainOneRecordingStatement(222, {
      commitment: '0xreal', proof_type: 'plonky3_range_check', proof_bytes: 'QkFTRTY0',
      public_statement: 'RepID > 200', repid_score_actual: 222, tier: 'PROBATIONARY',
    });
    // #395 corpus-hygiene: the recorded statement is now AGENT-BOUND (buildBoundStatement) — the
    // canonical 4-key shape {agent_id, tier, repid_score, threshold}, not the old 2-key form. tier is
    // derived from the proven score (222 -> PROBATIONARY). The live-score guarantee this test locks is
    // unchanged: repid_score tracks the live value (222), never a hard-coded 1000.
    expect(row.statement).toEqual({
      agent_id: '00000000-0000-0000-0000-000000000222',
      tier: 'PROBATIONARY',
      repid_score: 222,
      threshold: 200,
    });
    expect((row.statement as any).repid_score).not.toBe(1000);
  });

  test('live-score FALLBACK path: prover omits repid_score_actual → statement uses the live 222 (not 1000)', async () => {
    // This is the load-bearing case: if the statement embedded a constant, THIS is where it
    // would surface — the prover sends no score, so the engine must fall back to the LIVE
    // repid_score_events.repid_after (222), which is exactly what it does.
    const row = await drainOneRecordingStatement(222, {
      commitment: '0xreal', proof_type: 'plonky3_range_check', proof_bytes: 'QkFTRTY0',
      public_statement: 'RepID > 200', tier: 'PROBATIONARY',
      // NOTE: no repid_score_actual field
    });
    // #395 corpus-hygiene: the recorded statement is now AGENT-BOUND (buildBoundStatement) — the
    // canonical 4-key shape {agent_id, tier, repid_score, threshold}, not the old 2-key form. tier is
    // derived from the proven score (222 -> PROBATIONARY). The live-score guarantee this test locks is
    // unchanged: repid_score tracks the live value (222), never a hard-coded 1000.
    expect(row.statement).toEqual({
      agent_id: '00000000-0000-0000-0000-000000000222',
      tier: 'PROBATIONARY',
      repid_score: 222,
      threshold: 200,
    });
    expect((row.statement as any).repid_score).not.toBe(1000);
  });

  test('the statement TRACKS the live score: a different synthetic score (777) yields 777', async () => {
    // Proves the value is not pinned to any constant — change the live input, the statement follows.
    const row = await drainOneRecordingStatement(777, {
      commitment: '0xreal', proof_type: 'plonky3_range_check', proof_bytes: 'QkFTRTY0',
      public_statement: 'RepID > 500', tier: 'EARNING',
    });
    expect((row.statement as any).repid_score).toBe(777);
  });
});
