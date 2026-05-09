import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { createProofWorkerService } from '../proof-worker-service';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const ZKP_SERVICE_URL = process.env.ZKP_SERVICE_URL || 'https://zkp-postcard-production.up.railway.app';
const PORT = parseInt(process.env.PORT || '3003', 10);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[ProofWorker] Missing Supabase configuration');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const service = createProofWorkerService({
  supabase,
  zkpServiceUrl: ZKP_SERVICE_URL,
  pollIntervalMs: 15000,
  batchSize: 20,
  maxAttempts: 5
});

const app = express();

app.get('/health', (req, res) => {
  const status = service.getStatus();
  res.json({
    ok: status.status === 'running',
    status: status.status,
    lastTickAt: status.lastTickAt,
    startedAt: status.startedAt
  });
});

app.get('/metrics', (req, res) => {
  const status = service.getStatus();
  res.json({
    jobsProcessedTotal: status.jobsProcessedTotal,
    jobsFailedTotal: status.jobsFailedTotal,
    lastError: status.lastError
  });
});

async function main() {
  console.log(`[ProofWorker] Initializing service against ${ZKP_SERVICE_URL}...`);
  await service.start();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[ProofWorker] Health server running on port ${PORT}`);
  });
}

process.on('SIGTERM', async () => {
  console.log('[ProofWorker] SIGTERM received, shutting down...');
  await service.stop();
  process.exit(0);
});

main().catch(err => {
  console.error('[ProofWorker] Fatal error during startup:', err);
  process.exit(1);
});
