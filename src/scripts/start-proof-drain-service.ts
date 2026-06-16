import * as dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createProofDrainService } from '../services/proof-drain-service';
import { pgPing } from '../db/direct-pg';

dotenv.config();

process.on('uncaughtException', (err) => {
  console.error('[ProofDrainService] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[ProofDrainService] Unhandled rejection:', err);
  process.exit(1);
});

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv('SUPABASE_SERVICE_KEY');
  // REAL-PROVER ROUTING (Phase 2, 2026-06-15):
  // Default changed: point to the real Plonky3 prover (hyperdag-core) so new proofs write
  // real scheme + proof_bytes. The old zkp-postcard stub prover is the fallback for legacy.
  // Sean sets ZKP_SERVICE_URL=https://hyperdag-core-production.up.railway.app on Railway.
  // ⚠️  ALSO set ZKP_SERVICE_URL on repid-engine (pipeline.ts enqueue) to the SAME URL so the
  //     queue's zkp_service_url column matches and the drain worker's filter picks them up.
  //     Existing queue rows with the old URL stay on the old worker — they will drain normally
  //     once the old drain depletes them; new enqueues go to the new URL.
  const zkpServiceUrl = process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app';

  const pollIntervalMs = process.env.PROOF_DRAIN_POLL_INTERVAL_MS ? parseInt(process.env.PROOF_DRAIN_POLL_INTERVAL_MS, 10) : 2000;
  const idleSleepMs = process.env.PROOF_DRAIN_IDLE_SLEEP_MS ? parseInt(process.env.PROOF_DRAIN_IDLE_SLEEP_MS, 10) : 10000;
  const batchSize = process.env.PROOF_DRAIN_BATCH_SIZE ? parseInt(process.env.PROOF_DRAIN_BATCH_SIZE, 10) : 20;
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // PostgREST bypass (2026-05-21) — boot diagnostic. fetchPendingBatch (the
  // entry point to all drain work) now uses direct-pg, so a failed ping means
  // the worker can't fetch jobs. Loud, non-fatal (the per-call circuit breaker
  // + /health endpoint surface ongoing degradation; we avoid a restart loop).
  const ping = await pgPing();
  if (ping.ok) {
    console.log(`[direct-pg] ping OK: latency=${ping.latencyMs}ms (pool max=5)`);
  } else {
    console.error(`[direct-pg] PING FAILED after ${ping.latencyMs}ms: ${ping.error} — fetchPendingBatch will fail until DATABASE_URL is set (Supavisor transaction pooler, port 6543)`);
  }

  const service = createProofDrainService({
    supabase,
    zkpServiceUrl,
    pollIntervalMs,
    idleSleepMs,
    batchSize
  });

  // Boot log — makes a silent crash visible in Railway logs immediately.
  console.log(`[ProofDrainService] boot complete: zkpServiceUrl=${zkpServiceUrl} PROOF_DRAIN_RECORD_REAL_FIELDS=${process.env.PROOF_DRAIN_RECORD_REAL_FIELDS ?? 'false'} EAS_CONTINUOUS_ANCHOR_ENABLED=${process.env.EAS_CONTINUOUS_ANCHOR_ENABLED ?? 'false'}`);

  await service.start();

  // Periodic heartbeat: logs a one-liner every 60 s so a frozen/looping worker is visible
  // as a gap in Railway log timestamps. Does NOT affect scoring or DB writes; purely
  // observability. RULE-8: setInterval ref-counted by the process; cleared on shutdown.
  const HEARTBEAT_INTERVAL_MS = 60_000;
  const heartbeatTimer = setInterval(() => {
    const s = service.getStatus();
    console.log(
      `[ProofDrainService][heartbeat] status=${s.status} ticks=${s.ticksTotal} completed=${s.jobsCompletedTotal} failed=${s.jobsFailedTotal} lastTick=${s.lastTickAt ?? 'never'} lastDrain=${s.lastDrainAt ?? 'never'}`
    );
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref(); // don't hold the event loop open for the timer alone

  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    const s = service.getStatus();
    const now = Date.now();
    const lastTickMs = s.lastTickAt ? now - new Date(s.lastTickAt).getTime() : null;
    
    // Improved robustness for Railway:
    // Allow service to remain 'healthy' even with recent errors to prevent restart loops.
    // Only 503 if we've completely stalled for 10 minutes.
    
    const stallThresholdMs = 10 * 60 * 1000;
    const extremeStall = lastTickMs !== null && lastTickMs > stallThresholdMs;
    const ok = (s.status === 'running' || s.status === 'starting') && !extremeStall;
    
    res.status(ok ? 200 : 503).json({ 
      ok, 
      last_tick_age_ms: lastTickMs,
      ...s 
    });
  });

  app.get('/status', (_req: Request, res: Response) => {
    res.status(200).json(service.getStatus());
  });

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[ProofDrainService] Express listening on 0.0.0.0:${port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[ProofDrainService] Received ${signal}; shutting down...`);
    clearInterval(heartbeatTimer);
    await service.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch((err) => {
  console.error('[ProofDrainService] startup failed:', err);
  process.exit(1);
});
