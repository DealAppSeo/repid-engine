/**
 * scripts/dispatch/cosign-consumer.ts — run-once / loop entrypoint for the awaiting_cosign consumer.
 *
 * This is the dispatch-side driver for src/services/cosign-consumer.ts. It stays fail-closed and
 * flag-gated: it refuses to do anything unless COSIGN_CONSUMER_ENABLED=true, so accidentally
 * invoking it in an environment where the flag is unset is a safe no-op.
 *
 *   npx ts-node scripts/dispatch/cosign-consumer.ts            # single sweep (default)
 *   npx ts-node scripts/dispatch/cosign-consumer.ts --loop     # start the polling interval
 *
 * DO NOT enable in prod without Sean GO — this is the first thing that can flip real
 * trinity_tasks rows to `done`.
 */
import { db } from '../../src/db';
import {
  cosignConsumerEnabled,
  processAwaitingCosign,
  startCosignConsumer,
  awaitingStatus,
  doneStatus,
} from '../../src/services/cosign-consumer';

async function main() {
  if (!cosignConsumerEnabled()) {
    console.log('[cosign-consumer] COSIGN_CONSUMER_ENABLED != true — nothing to do (fail-closed). Exiting.');
    return;
  }
  console.log(`[cosign-consumer] gate '${awaitingStatus()}' → '${doneStatus()}'`);

  if (process.argv.includes('--loop')) {
    startCosignConsumer(db);
    console.log('[cosign-consumer] loop started; press Ctrl-C to stop.');
    return; // interval keeps the process alive
  }

  const r = await processAwaitingCosign(db);
  console.log(`[cosign-consumer] sweep complete: scanned=${r.scanned} advanced=${r.advanced} held=${r.held}`);
}

main().catch((e) => {
  console.error('[cosign-consumer] fatal:', e?.message ?? e);
  process.exitCode = 1;
});
