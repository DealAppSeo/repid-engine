import * as dotenv from 'dotenv';
import express from 'express';
import { startIndexer } from './services/receipt-indexer';

dotenv.config();

// Reconnect/crash logic: process exits on unhandled errors, Railway restarts it
process.on('uncaughtException', (err) => {
  console.error('[Indexer] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[Indexer] Unhandled rejection:', err);
  process.exit(1);
});

async function main() {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
  const contractAddress = process.env.HYPERDAG_RECEIPT_ADAPTER_ADDRESS;
  if (!contractAddress) {
    throw new Error('Missing HYPERDAG_RECEIPT_ADAPTER_ADDRESS');
  }
  const fromBlock = process.env.INDEXER_START_BLOCK ? parseInt(process.env.INDEXER_START_BLOCK, 10) : 'latest';
  const pollInterval = process.env.INDEXER_POLL_INTERVAL_MS ? parseInt(process.env.INDEXER_POLL_INTERVAL_MS, 10) : 5000;

  console.log('[Indexer] Booting service...');
  await startIndexer({
    rpcUrl,
    contractAddress,
    fromBlock,
    pollInterval
  });
  console.log('[Indexer] Event listeners established.');

  // Healthcheck server
  const app = express();
  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', service: 'receipt-indexer' });
  });

  const port = process.env.PORT || 8080;
  app.listen(port, () => {
    console.log(`[Indexer] Healthcheck server listening on port ${port}`);
  });
}

main().catch(err => {
  console.error('[Indexer] Initialization failed:', err);
  process.exit(1);
});
