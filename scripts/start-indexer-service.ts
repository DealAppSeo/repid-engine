import * as dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createIndexerService } from '../src/services/receipt-indexer-service';

dotenv.config();

process.on('uncaughtException', (err) => {
  console.error('[IndexerService] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[IndexerService] Unhandled rejection:', err);
  process.exit(1);
});

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  const contractAddress = requireEnv('HYPERDAG_RECEIPT_ADAPTER_ADDRESS');
  const supabaseUrl = requireEnv('SUPABASE_URL');
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv('SUPABASE_SERVICE_KEY');

  const chainId = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : 84532;
  const pollIntervalMs = process.env.INDEXER_POLL_INTERVAL_MS ? parseInt(process.env.INDEXER_POLL_INTERVAL_MS, 10) : 10000;
  const blockWindow = process.env.INDEXER_BLOCK_WINDOW ? parseInt(process.env.INDEXER_BLOCK_WINDOW, 10) : 100;
  const tipLagBlocks = process.env.INDEXER_TIP_LAG_BLOCKS ? parseInt(process.env.INDEXER_TIP_LAG_BLOCKS, 10) : 1;
  const bftPollIntervalMs = process.env.INDEXER_BFT_POLL_INTERVAL_MS ? parseInt(process.env.INDEXER_BFT_POLL_INTERVAL_MS, 10) : 5000;
  const startBlockFallback = process.env.INDEXER_START_BLOCK ? parseInt(process.env.INDEXER_START_BLOCK, 10) : undefined;
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const service = createIndexerService({
    rpcUrl,
    contractAddress,
    chainId,
    supabase,
    pollIntervalMs,
    blockWindow,
    tipLagBlocks,
    bftPollIntervalMs,
    startBlockFallback
  });

  await service.start();

  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_req: Request, res: Response) => {
    const s = service.getStatus();
    const now = Date.now();
    const lastTickMs = s.lastTickAt ? now - new Date(s.lastTickAt).getTime() : null;
    const tickStale = lastTickMs !== null && lastTickMs > pollIntervalMs * 2;
    const recentError = s.lastError && now - new Date(s.lastError.at).getTime() < pollIntervalMs * 2;
    const ok = s.status === 'running' && !tickStale && !recentError;
    res.status(ok ? 200 : 503).json({ ok, ...s });
  });

  app.get('/status', (_req: Request, res: Response) => {
    res.status(200).json(service.getStatus());
  });

  app.post('/backfill', async (req: Request, res: Response) => {
    try {
      const { fromBlock, toBlock } = req.body ?? {};
      if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock)) {
        res.status(400).json({ error: 'fromBlock and toBlock must be integers' });
        return;
      }
      const result = await service.runBackfill(fromBlock, toBlock);
      res.status(200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[IndexerService] Express listening on 0.0.0.0:${port}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`[IndexerService] Received ${signal}; shutting down...`);
    await service.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

main().catch((err) => {
  console.error('[IndexerService] startup failed:', err);
  process.exit(1);
});
