import { startRecoveryWorker } from '../../src/services/x402-recovery-worker';

console.log('Starting X402 Recovery Worker...');
const worker = startRecoveryWorker({ pollIntervalMs: 30000 });

process.on('SIGINT', () => {
  console.log('Stopping recovery worker...');
  worker.stop();
  process.exit(0);
});
