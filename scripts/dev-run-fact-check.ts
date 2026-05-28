/**
 * One-off dev runner for FactCheckServiceHandler — drives processOne() against
 * the live DB so we can verify end-to-end (Phase 3 of the fact_check sprint).
 *
 * Production-side path is identical: the cascade-settlement-worker calls
 * `handler.processOne(providerAgentId)` on a timer. This script just invokes
 * that same entry point manually, three times, for a single provider whose
 * agent_services row has been seeded for service_type='fact_check'.
 *
 * Not part of any built artifact. Run with:
 *   npx ts-node scripts/dev-run-fact-check.ts <provider_agent_id>
 *
 * Or omit the argument to use the seeded trinity-veritas id.
 */

import 'dotenv/config';
import { FactCheckServiceHandler } from '../src/services/fact-check-service-handler';

const DEFAULT_PROVIDER = 'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067'; // trinity-veritas

async function main() {
  const provider = process.argv[2] ?? DEFAULT_PROVIDER;
  const handler = new FactCheckServiceHandler();

  console.log(`[dev-run-fact-check] provider=${provider}`);
  console.log('[dev-run-fact-check] draining escrowed fact_check contracts...\n');

  for (let i = 1; i <= 5; i++) {
    const before = Date.now();
    const result = await handler.processOne(provider);
    const elapsed = Date.now() - before;

    if (!result.processed) {
      if (result.error) {
        console.log(`[cycle ${i}] error: ${result.error} (${elapsed}ms)`);
      } else {
        console.log(`[cycle ${i}] no escrowed contracts left for this provider (${elapsed}ms)`);
      }
      break;
    }
    console.log(`[cycle ${i}] processed contract ${result.contract_id} (${elapsed}ms)`);
  }

  console.log('\n[dev-run-fact-check] done. Inspect service_contracts.result for the trace.');
}

main().catch((e) => {
  console.error('[dev-run-fact-check] unhandled:', e?.message ?? e, e?.stack);
  process.exit(1);
});
