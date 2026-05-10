import type { SupabaseClient } from '@supabase/supabase-js';

export interface ProofDrainServiceConfig {
  supabase: SupabaseClient;
  zkpServiceUrl: string;
  pollIntervalMs?: number;
  idleSleepMs?: number;
  batchSize?: number;
  stallThresholdMs?: number;
  fetchImpl?: typeof fetch;
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

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 4000, 16000];

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRY_ATTEMPTS) {
        const delay = RETRY_DELAYS_MS[attempt - 1] ?? 16000;
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
    const { data, error } = await config.supabase
      .from('repid_proof_queue')
      .select('id, job_id, agent_id, event_id, status')
      .eq('status', 'pending')
      .eq('zkp_service_url', config.zkpServiceUrl)
      .limit(batchSize);
    if (error) throw new Error(`fetch pending failed: ${error.message}`);
    return data ?? [];
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

  async function markCompleted(rowId: string, proofHash: string): Promise<void> {
    const { error } = await config.supabase
      .from('repid_proof_queue')
      .update({ status: 'completed', proof_hash: proofHash, completed_at: new Date().toISOString() })
      .eq('id', rowId);
    if (error) throw new Error(`mark completed failed: ${error.message}`);
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

    const proof = (await res.json()) as { commitment?: string; proof_hash?: string; hash?: string };
    const proofHash = proof.commitment ?? proof.proof_hash ?? proof.hash ?? '';
    await withRetry(`markCompleted[${job.id}]`, () => markCompleted(job.id, proofHash));
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
      console.error('[ProofDrain] tick failed:', message);
      return 0;
    } finally {
      tickInFlight = false;
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      const processed = await tick();
      const sleepMs = processed > 0 ? pollIntervalMs : idleSleepMs;
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
