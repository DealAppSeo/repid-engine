import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { createIndexerService } from '../receipt-indexer-service';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RPC_URL = process.env.INDEXER_RPC_URL || process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const CONTRACT_ADDRESS = process.env.RECEIPT_ADAPTER_ADDRESS || '0x6f3519cb9d0c2edc908e9d956538f20eb51b06cf';
const PORT = parseInt(process.env.PORT || '3002', 10);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[Indexer] Missing Supabase configuration');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const service = createIndexerService({
  rpcUrl: RPC_URL,
  contractAddress: CONTRACT_ADDRESS,
  chainId: 177, // Base Sepolia
  supabase,
  pollIntervalMs: 15000,
  bftPollIntervalMs: 30000,
  tipLagBlocks: 2,
  startBlockFallback: 21960000 // Close to current tip if cold start
});

const app = express();

app.get('/health', (req, res) => {
  const status = service.getStatus();
  res.json({
    ok: status.status === 'running',
    status: status.status,
    lastBlock: status.lastBlock,
    lastTickAt: status.lastTickAt,
    lagBlocks: status.lagBlocks,
    startedAt: status.startedAt
  });
});

app.get('/metrics', (req, res) => {
  const status = service.getStatus();
  res.json({
    eventsProcessedTotal: status.eventsProcessedTotal,
    ticksTotal: status.ticksTotal,
    bftTicksTotal: status.bftTicksTotal,
    lastError: status.lastError,
    cursorKey: status.cursorKey
  });
});

async function main() {
  console.log(`[Indexer] Initializing service for ${CONTRACT_ADDRESS}...`);
  await service.start();
  
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Indexer] Health server running on port ${PORT}`);
  });
}

process.on('SIGTERM', async () => {
  console.log('[Indexer] SIGTERM received, shutting down...');
  await service.stop();
  process.exit(0);
});

main().catch(err => {
  console.error('[Indexer] Fatal error during startup:', err);
  process.exit(1);
});
