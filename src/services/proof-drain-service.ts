import type { SupabaseClient } from '@supabase/supabase-js';
import { pgQuery } from '../db/direct-pg';

export interface ProofDrainServiceConfig {
  supabase: SupabaseClient;
  zkpServiceUrl: string;
  pollIntervalMs?: number;
  idleSleepMs?: number;
  batchSize?: number;
  stallThresholdMs?: number;
  fetchImpl?: typeof fetch;
  // PostgREST bypass (2026-05-21) — injectable direct-pg query fn for the hot
  // fetchPendingBatch poll. Defaults to the real pgQuery; tests pass a mock.
  pgQueryImpl?: typeof pgQuery;
}

export interface ProofDrainServiceStatus {
  status: 'starting' | 'running' | 'stopped' | 'error';
  startedAt: string | null;
  lastTickAt: string | null;
  lastDrainAt: string | null;
  jobsCompletedTotal: number;
  jobsFailedTotal: number;
  ticksTotal: number;
  lastError: { message: string; at: string } | null;
  zkpServiceUrl: string;
}

export interface ProofDrainService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): ProofDrainServiceStatus;
  drainOnce(): Promise<{ jobsCompleted: number; jobsFailed: number }>;
}

export const DEFAULT_PROOF_DRAIN_STALL_MS = 10 * 60 * 1000;

// Phase 7B (Unbounded Wait Disease) — broader exponential backoff so a slow
// upstream (Supabase compute degraded, prover hanging) doesn't translate into
// a tight retry storm. Previously: 3 attempts at 1s + 4s + 16s (max ~21s
// elapsed before throw + 10s idle sleep = ~31s per failure cycle, observed in
// production as the 14h+ retry storm of 2026-05-21). Now: 5 attempts with
// cap-at-256s tail (max ~341s elapsed before throw + cool-down).
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [1000, 4000, 16000, 64000, 256000];

// Phase 7B's withQueryTimeout helper (Promise.race over a supabase-js thenable)
// was removed 2026-05-21: fetchPendingBatch now uses direct pg via pgQuery,
// which owns its own per-attempt timeout + circuit breaker. The remaining
// supabase-js calls in this file (markCompleted/markFailed/insertCanonicalProof/
// fetchScore/emitStallHitl) are low-frequency and stay on supabase-js.

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRY_ATTEMPTS) {
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? 256000;
        console.warn(`[ProofDrain] ${label} attempt ${attempt}/${MAX_RETRY_ATTEMPTS} failed; retrying in ${delay}ms:`, err instanceof Error ? err.message : err);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

export function createProofDrainService(config: ProofDrainServiceConfig): ProofDrainService {
  const pollIntervalMs = config.pollIntervalMs ?? 2000;
  const idleSleepMs = config.idleSleepMs ?? 10000;
  const batchSize = config.batchSize ?? 20;
  const stallThresholdMs = config.stallThresholdMs ?? DEFAULT_PROOF_DRAIN_STALL_MS;
  const httpFetch = config.fetchImpl ?? fetch;
  const pgq = config.pgQueryImpl ?? pgQuery;

  const state: ProofDrainServiceStatus = {
    status: 'stopped',
    startedAt: null,
    lastTickAt: null,
    lastDrainAt: null,
    jobsCompletedTotal: 0,
    jobsFailedTotal: 0,
    ticksTotal: 0,
    lastError: null,
    zkpServiceUrl: config.zkpServiceUrl
  };

  let loopTimer: NodeJS.Timeout | null = null;
  let tickInFlight = false;
  let stopped = false;

  let lastDrainAt = Date.now();
  let stallNotified = false;

  // Phase 7B (Unbounded Wait Disease cool-down) — circuit breaker. Tracks
  // consecutive `tick failed` outcomes. After CIRCUIT_OPEN_THRESHOLD
  // consecutive failures the loop sleeps CIRCUIT_OPEN_SLEEP_MS before the
  // next tick attempt (default 5min) instead of the usual idleSleepMs.
  // Reset to 0 on any successful tick (jobsCompleted + jobsFailed > 0 path
  // OR drainOnce returning a clean empty batch). Counter increments only in
  // tick's outer catch (drainOnce threw).
  const CIRCUIT_OPEN_THRESHOLD = 5;
  const CIRCUIT_OPEN_SLEEP_MS = 5 * 60 * 1000; // 5 minutes
  let consecutiveTickFailures = 0;
  let circuitOpenLogged = false;

  async function emitStallHitl(queueDepth: number, elapsedMs: number): Promise<void> {
    try {
      const { error } = await config.supabase.from('trinity_hitl_requests').insert({
        agent_id: 'service:proof-drain-worker',
        reason: 'worker_stalled',
        status: 'pending',
        context: {
          zkpServiceUrl: config.zkpServiceUrl,
          queueDepth,
          stallThresholdMs,
          elapsedMs,
          detectedAt: new Date().toISOString()
        }
      });
      if (error) {
        console.error('[ProofDrain] failed to write stall HITL request:', error.message);
        return;
      }
      console.warn(`[ProofDrain] STALL detected — no successful drain for ${elapsedMs}ms with queue_depth=${queueDepth}; HITL request raised`);
    } catch (err) {
      console.error('[ProofDrain] stall HITL emit threw:', err instanceof Error ? err.message : err);
    }
  }

  async function fetchPendingBatch(): Promise<Array<{ id: string; job_id: string; agent_id: string; event_id: string; status: string }>> {
    // PostgREST bypass (2026-05-21) — direct pg SELECT in place of the
    // supabase query builder. pgQuery owns the per-attempt timeout + circuit
    // breaker (RULE-8), so the Phase-7B withQueryTimeout wrapper is no longer
    // needed here; the drainOnce-level withRetry still provides outer retry, so
    // we keep retries:1 (single attempt) to preserve that structure.
    const rows = await pgq<{ id: string; job_id: string; agent_id: string; event_id: string; status: string }>(
      `SELECT id, job_id, agent_id, event_id, status
       FROM repid_proof_queue
       WHERE status = $1 AND zkp_service_url = $2
       LIMIT $3`,
      ['pending', config.zkpServiceUrl, batchSize],
      { retries: 1, label: 'fetchPendingBatch' }
    );
    return rows;
  }

  async function fetchScore(eventId: string): Promise<number | null> {
    const { data, error } = await config.supabase
      .from('repid_score_events')
      .select('repid_after')
      .eq('id', eventId)
      .single();
    if (error || !data) return null;
    return Math.round((data as { repid_after: number }).repid_after);
  }

  /**
   * Phase 7 Gap B — canonical proof artifact write to repid_zkp_proofs.
   *
   * Non-fatal: any failure here is logged loudly but never thrown. The queue
   * UPDATE in markCompleted() is the primary truth; this insert is additive
   * evidence. A retry of markCompleted() must NOT re-run this insert (no
   * unique constraint on (agent_id, zk_commitment); we would create duplicate
   * rows). Hence the `try/catch` + log-only pattern.
   *
   * Schema mapping (verified Phase 7 against information_schema):
   *   - repid_zkp_proofs.proof_type    text NOT NULL, CHECK in {'POSTCARD','ENVELOPE','PACKAGE'}
   *   - repid_zkp_proofs.tier_proven   text NOT NULL  (PROBATIONARY|EARNING|ESTABLISHED|AUTONOMOUS|VETERAN)
   *   - repid_zkp_proofs.agent_id      uuid nullable
   *   - repid_zkp_proofs.merkle_root   text nullable
   *   - repid_zkp_proofs.zk_commitment text nullable
   *   - eas_attestation_uid            text nullable (V1.x will fill from EAS flow)
   *   - eas_schema                     defaults to 'constitutional-compliance-v1'
   *
   * proof_type mapping: the prover (zkp-postcard service) emits
   * proof_type='plonky3_range_check' or 'sha256_commitment_poc' — its
   * INTERNAL algorithm variant — neither of which satisfies the CHECK
   * constraint. Since both come from the zkp-postcard service (which produces
   * Postcard-tier proofs regardless of the inner algorithm), we always write
   * 'POSTCARD' here. The algorithm-variant info is preserved in proof_bytes
   * (binary format encodes its own version). Envelope/Package tiers will be
   * written by future provers (zkp-envelope, zkp-package).
   *
   * tier_proven: authoritative source is repid_agents.tier (kept in sync by
   * the trg_sync_tier Postgres trigger; do NOT trust the prover's tier field
   * — it's app-supplied per Sean's CLAUDE.md guidance). Fallback to
   * 'PROBATIONARY' if the agent row is missing, so we never violate the
   * NOT NULL constraint.
   */
  async function insertCanonicalProof(args: {
    agentId: string;
    commitment: string;
    merkleRoot: string | null;
  }): Promise<void> {
    try {
      let tierProven = 'PROBATIONARY';
      try {
        const { data: agent } = await config.supabase
          .from('repid_agents')
          .select('tier')
          .eq('id', args.agentId)
          .maybeSingle();
        if (agent && (agent as any).tier) {
          tierProven = (agent as any).tier;
        } else {
          console.warn(`[ProofDrain] repid_agents row missing for ${args.agentId}; defaulting tier_proven=PROBATIONARY`);
        }
      } catch (e) {
        console.warn(`[ProofDrain] tier lookup threw for ${args.agentId}:`, e instanceof Error ? e.message : e);
      }

      const { error } = await config.supabase.from('repid_zkp_proofs').insert({
        agent_id: args.agentId,
        proof_type: 'POSTCARD',
        tier_proven: tierProven,
        merkle_root: args.merkleRoot,
        zk_commitment: args.commitment || null,
        // eas_attestation_uid: NULL — EAS flow is V1.x
        // eas_schema: defaults to 'constitutional-compliance-v1'
        // created_at: defaults to NOW()
      });
      if (error) {
        console.error(
          `[ProofDrain] repid_zkp_proofs INSERT failed for ${args.agentId} (queue stays completed):`,
          error.message,
          error
        );
      }
    } catch (e) {
      console.error(
        `[ProofDrain] insertCanonicalProof threw for ${args.agentId} (queue stays completed):`,
        e instanceof Error ? e.message : e,
        e instanceof Error ? e.stack : undefined
      );
    }
  }

  /**
   * Phase 7 Gap A — markCompleted now persists proof_bytes + proof_size_bytes
   * onto the queue row (the bytes were being discarded pre-Phase-7: 1 of
   * 2716 completed queue rows had proof_bytes populated, the rest were
   * NULL because this UPDATE list omitted them). Followed by Gap B's
   * canonical insert to repid_zkp_proofs.
   */
  async function markCompleted(args: {
    rowId: string;
    agentId: string;
    proofHash: string;
    proofBytes: string | null;
    proofSizeBytes: number | null;
    commitment: string;
    merkleRoot: string | null;
  }): Promise<void> {
    const { error } = await config.supabase
      .from('repid_proof_queue')
      .update({
        status: 'completed',
        proof_hash: args.proofHash,
        proof_bytes: args.proofBytes,
        proof_size_bytes: args.proofSizeBytes,
        completed_at: new Date().toISOString()
      })
      .eq('id', args.rowId);
    if (error) throw new Error(`mark completed failed: ${error.message}`);

    // Gap B — additive evidence insert. Non-fatal; never throws.
    await insertCanonicalProof({
      agentId: args.agentId,
      commitment: args.commitment,
      merkleRoot: args.merkleRoot,
    });
  }

  async function markFailed(rowId: string, message: string): Promise<void> {
    const { error } = await config.supabase
      .from('repid_proof_queue')
      .update({ status: 'failed', error_message: message })
      .eq('id', rowId);
    if (error) {
      console.error('[ProofDrain] mark failed update errored:', error.message);
    }
  }

  async function processJob(job: { id: string; job_id: string; agent_id: string; event_id: string }): Promise<'completed' | 'failed'> {
    const score = await withRetry(`fetchScore[${job.event_id}]`, () => fetchScore(job.event_id));
    if (score === null) {
      await markFailed(job.id, 'Score event not found');
      return 'failed';
    }

    const res = await withRetry(`zkp.prove[${job.job_id}]`, async () => {
      const r = await httpFetch(`${config.zkpServiceUrl}/zkp/repid-proof`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: job.agent_id,
          score,
          metadata: { job_id: job.job_id }
        })
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${text}`);
      }
      return r;
    });

    // Phase 7 Gap A — parse the FULL prover response (was discarding everything
    // but commitment/hash). Prover JSON shape per the zkp-postcard service:
    //   { proof_type, tier, commitment, proof_bytes, proof_size_bytes?, merkle_root? }
    const proof = (await res.json()) as {
      commitment?: string;
      proof_hash?: string;
      hash?: string;
      proof_bytes?: string;
      proof_size_bytes?: number;
      proof_type?: string;
      tier?: string;
      merkle_root?: string;
    };
    const proofHash = proof.commitment ?? proof.proof_hash ?? proof.hash ?? '';
    const commitment = proof.commitment ?? '';
    const proofBytes = typeof proof.proof_bytes === 'string' ? proof.proof_bytes : null;
    // Prefer the prover's declared size; fall back to a Base64-length estimate
    // when bytes are present but the size field isn't (the prior 2716/2642 row
    // distribution shows size was sometimes populated independently — preserve
    // that signal when available).
    const proofSizeBytes =
      typeof proof.proof_size_bytes === 'number'
        ? proof.proof_size_bytes
        : proofBytes
          ? Math.ceil((proofBytes.length * 3) / 4)
          : null;
    const merkleRoot = typeof proof.merkle_root === 'string' ? proof.merkle_root : null;

    await withRetry(`markCompleted[${job.id}]`, () =>
      markCompleted({
        rowId: job.id,
        agentId: job.agent_id,
        proofHash,
        proofBytes,
        proofSizeBytes,
        commitment,
        merkleRoot,
      })
    );
    return 'completed';
  }

  async function drainOnce(): Promise<{ jobsCompleted: number; jobsFailed: number }> {
    const jobs = await withRetry('fetchPendingBatch', fetchPendingBatch);
    let completed = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        const outcome = await processJob(job);
        if (outcome === 'completed') completed++;
        else failed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await markFailed(job.id, message);
        failed++;
      }
    }
    return { jobsCompleted: completed, jobsFailed: failed };
  }

  async function tick(): Promise<number> {
    if (tickInFlight) return 0;
    tickInFlight = true;
    try {
      const { jobsCompleted, jobsFailed } = await drainOnce();
      state.lastTickAt = new Date().toISOString();
      state.jobsCompletedTotal += jobsCompleted;
      state.jobsFailedTotal += jobsFailed;
      state.ticksTotal += 1;
      // Phase 7B circuit-breaker — drainOnce returned without throwing,
      // so the tick "succeeded" (regardless of per-job pass/fail). Reset
      // the consecutive-failure counter and re-arm the open-log gate.
      if (consecutiveTickFailures > 0 || circuitOpenLogged) {
        console.log(`[ProofDrain] circuit-breaker reset — tick succeeded after ${consecutiveTickFailures} consecutive failures`);
        consecutiveTickFailures = 0;
        circuitOpenLogged = false;
      }
      if (jobsCompleted > 0) {
        state.lastDrainAt = new Date().toISOString();
        lastDrainAt = Date.now();
        stallNotified = false;
        console.log(`[ProofDrain] tick +${jobsCompleted} completed, ${jobsFailed} failed`);
      } else {
        const queueDepth = jobsFailed;
        const now = Date.now();
        if (queueDepth > 0 && !stallNotified && now - lastDrainAt > stallThresholdMs) {
          stallNotified = true;
          await emitStallHitl(queueDepth, now - lastDrainAt);
        }
      }
      return jobsCompleted + jobsFailed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.lastError = { message, at: new Date().toISOString() };
      consecutiveTickFailures += 1;
      console.error(`[ProofDrain] tick failed (consecutive=${consecutiveTickFailures}/${CIRCUIT_OPEN_THRESHOLD}):`, message);
      if (consecutiveTickFailures >= CIRCUIT_OPEN_THRESHOLD && !circuitOpenLogged) {
        circuitOpenLogged = true;
        console.error(`[ProofDrain] CIRCUIT OPEN — ${CIRCUIT_OPEN_THRESHOLD}+ consecutive tick failures; sleeping ${CIRCUIT_OPEN_SLEEP_MS}ms (5min) between tick attempts until upstream recovers`);
      }
      return 0;
    } finally {
      // Phase 7B safety net — tickInFlight MUST be released even on synchronous
      // throw, abort propagation, or process-level interrupts that re-enter
      // the JS event loop. finally runs regardless of how try/catch exits.
      tickInFlight = false;
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      const processed = await tick();
      // Phase 7B — sleep choice (in order):
      //  1. Circuit open (≥ CIRCUIT_OPEN_THRESHOLD consecutive failures):
      //     CIRCUIT_OPEN_SLEEP_MS (5min) — give upstream time to recover.
      //  2. Work done this tick: pollIntervalMs (default 2s).
      //  3. Idle/no-work: idleSleepMs (default 10s).
      let sleepMs: number;
      if (consecutiveTickFailures >= CIRCUIT_OPEN_THRESHOLD) {
        sleepMs = CIRCUIT_OPEN_SLEEP_MS;
      } else if (processed > 0) {
        sleepMs = pollIntervalMs;
      } else {
        sleepMs = idleSleepMs;
      }
      await new Promise<void>(resolve => {
        loopTimer = setTimeout(resolve, sleepMs);
      });
    }
  }

  return {
    async start() {
      if (state.status === 'running') return;
      state.status = 'starting';
      state.startedAt = new Date().toISOString();
      lastDrainAt = Date.now();
      stallNotified = false;
      stopped = false;
      console.log(`[ProofDrain] starting service zkp=${config.zkpServiceUrl} (poll=${pollIntervalMs}ms, idle=${idleSleepMs}ms, batch=${batchSize})`);
      state.status = 'running';
      void loop();
    },

    async stop() {
      stopped = true;
      if (loopTimer) { clearTimeout(loopTimer); loopTimer = null; }
      state.status = 'stopped';
    },

    getStatus() {
      return { ...state };
    },

    drainOnce
  };
}
