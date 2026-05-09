import type { SupabaseClient } from '@supabase/supabase-js';

export interface ProofWorkerConfig {
  supabase: SupabaseClient;
  zkpServiceUrl: string;
  pollIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
}

export interface ProofWorkerStatus {
  status: 'starting' | 'running' | 'stopped' | 'error';
  startedAt: string | null;
  lastTickAt: string | null;
  jobsProcessedTotal: number;
  jobsFailedTotal: number;
  lastError: { message: string; at: string } | null;
}

export interface ProofWorkerService {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): ProofWorkerStatus;
}

export function createProofWorkerService(config: ProofWorkerConfig): ProofWorkerService {
  const pollIntervalMs = config.pollIntervalMs ?? 10000;
  const batchSize = config.batchSize ?? 10;
  const maxAttempts = config.maxAttempts ?? 3;

  const state: ProofWorkerStatus = {
    status: 'stopped',
    startedAt: null,
    lastTickAt: null,
    jobsProcessedTotal: 0,
    jobsFailedTotal: 0,
    lastError: null
  };

  let timer: NodeJS.Timeout | null = null;
  let tickInFlight = false;

  async function tick(): Promise<void> {
    if (tickInFlight) return;
    tickInFlight = true;

    try {
      // 1. Fetch pending or retriable jobs
      const { data: jobs, error: fetchErr } = await config.supabase
        .from('repid_proof_queue')
        .select('*')
        .or(`status.eq.pending,and(status.eq.failed,attempts.lt.${maxAttempts})`)
        .order('created_at', { ascending: true })
        .limit(batchSize);

      if (fetchErr) throw fetchErr;

      if (!jobs || jobs.length === 0) {
        state.lastTickAt = new Date().toISOString();
        return;
      }

      console.log(`[ProofWorker] Processing batch of ${jobs.length} jobs...`);

      for (const job of jobs) {
        try {
          // Increment attempts
          await config.supabase
            .from('repid_proof_queue')
            .update({ attempts: (job.attempts || 0) + 1 })
            .eq('id', job.id);

          // 2. Fetch score from repid_score_events
          const { data: event, error: evErr } = await config.supabase
            .from('repid_score_events')
            .select('repid_after')
            .eq('id', job.event_id)
            .single();

          if (evErr || !event) {
            throw new Error(`Score event ${job.event_id} not found`);
          }

          const score = Math.round(event.repid_after);

          // 3. POST to ZKP service
          const res = await fetch(`${config.zkpServiceUrl}/zkp/repid-proof`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agent_id: job.agent_id,
              score: score,
              metadata: { job_id: job.job_id, event_id: job.event_id }
            })
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`ZKP service returned ${res.status}: ${errText}`);
          }

          const proof = await res.json();
          const commitment = proof.commitment || proof.proof_hash; // Handle both schemas

          if (!commitment) {
            throw new Error('ZKP service response missing commitment/proof_hash');
          }

          // 4. Update proof queue
          const { error: updErr } = await config.supabase
            .from('repid_proof_queue')
            .update({
              status: 'completed',
              proof_hash: commitment,
              completed_at: new Date().toISOString(),
              error_message: null
            })
            .eq('id', job.id);

          if (updErr) throw updErr;

          // 5. Update score event
          const { error: evUpdErr } = await config.supabase
            .from('repid_score_events')
            .update({
              zk_proof_id: job.job_id,
              proof_hash: commitment
            })
            .eq('id', job.event_id);

          if (evUpdErr) {
            console.warn(`[ProofWorker] Job ${job.id} completed but failed to update score event ${job.event_id}:`, evUpdErr.message);
          }

          state.jobsProcessedTotal += 1;

        } catch (jobErr: any) {
          console.error(`[ProofWorker] Job ${job.id} failed:`, jobErr.message);
          state.jobsFailedTotal += 1;
          
          await config.supabase
            .from('repid_proof_queue')
            .update({
              status: 'failed',
              error_message: jobErr.message,
              last_attempt_at: new Date().toISOString()
            })
            .eq('id', job.id);
        }
      }

      state.lastTickAt = new Date().toISOString();

    } catch (err: any) {
      const message = err.message || String(err);
      state.lastError = { message, at: new Date().toISOString() };
      console.error('[ProofWorker] tick failed:', message);
    } finally {
      tickInFlight = false;
    }
  }

  return {
    async start() {
      if (state.status === 'running') return;
      state.status = 'starting';
      state.startedAt = new Date().toISOString();
      console.log(`[ProofWorker] starting service (poll=${pollIntervalMs}ms, batch=${batchSize}, zkp=${config.zkpServiceUrl})`);
      
      // Run first tick immediately
      await tick();
      
      timer = setInterval(() => { void tick(); }, pollIntervalMs);
      state.status = 'running';
    },

    async stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      state.status = 'stopped';
      console.log('[ProofWorker] service stopped');
    },

    getStatus() {
      return { ...state };
    }
  };
}
