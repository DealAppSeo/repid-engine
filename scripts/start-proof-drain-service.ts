import * as dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createProofDrainService } from '../src/services/proof-drain-service';

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
  const zkpServiceUrl = process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app';

  const pollIntervalMs = process.env.PROOF_DRAIN_POLL_INTERVAL_MS ? parseInt(process.env.PROOF_DRAIN_POLL_INTERVAL_MS, 10) : 2000;
  const idleSleepMs = process.env.PROOF_DRAIN_IDLE_SLEEP_MS ? parseInt(process.env.PROOF_DRAIN_IDLE_SLEEP_MS, 10) : 10000;
  const batchSize = process.env.PROOF_DRAIN_BATCH_SIZE ? parseInt(process.env.PROOF_DRAIN_BATCH_SIZE, 10) : 20;
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const service = createProofDrainService({
    supabase,
    zkpServiceUrl,
    pollIntervalMs,
    idleSleepMs,
    batchSize
  });

  await service.start();

  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    const s = service.getStatus();
    const now = Date.now();
    const lastTickMs = s.lastTickAt ? now - new Date(s.lastTickAt).getTime() : null;
    const tickStale = lastTickMs !== null && lastTickMs > Math.max(idleSleepMs * 3, 60000);
    const recentError = s.lastError && now - new Date(s.lastError.at).getTime() < idleSleepMs * 2;
    const ok = s.status === 'running' && !tickStale && !recentError;
    res.status(ok ? 200 : 503).json({ ok, ...s });
  });

  app.get('/status', (_req: Request, res: Response) => {
    res.status(200).json(service.getStatus());
  });

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[ProofDrainService] Express listening on 0.0.0.0:${port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[ProofDrainService] Received ${signal}; shutting down...`);
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
