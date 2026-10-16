/**
 *   npx ts-node scripts/run-hal-validation.ts [1|2] [--ruler hal-sealed-v1]
 *
 * Measures HAL on a named ruler (default: the newest hal-sealed-v<N>). Every metric line carries the
 * ruler id, hash and N; the overall score is split into public-benchmark vs internal items.
 * Nothing here prints a case id or text: the sealed set stays sealed in logs.
 */
import { runValidationHarness } from '../src/services/hal-validation-runner';
import { rulerFromArgv } from '../src/hal/sealed-ruler';

async function main() {
  // Force strict mode for every harness run so silent degradations (missing
  // provider, classifier timeout, extractor failure) become loud, immediate
  // failures — we never measure a degraded pipeline and call it a baseline.
  // Production is unaffected: this only sets the env in this CLI process.
  process.env.HAL_STRICT_MODE = 'true';
  console.log('[harness] HAL_STRICT_MODE=true — degradations will fail loudly');

  const strictness: 1 | 2 = process.argv[2] === '2' ? 2 : 1;

  try {
    const { runId, report } = await runValidationHarness(strictness, { ruler: rulerFromArgv() });
    console.log(`\n======================================================`);
    console.log(`  HAL VALIDATION RUN ${runId} (strictness ${strictness})`);
    console.log(`  positive class = hallucination; predicted positive = decision 'vetoed'`);
    console.log(`======================================================`);
    for (const line of report.lines) console.log(line);
    console.log(`======================================================\n`);
    process.exit(0);
  } catch (e: any) {
    console.error(`Validation harness failed:`, e.message);
    process.exit(1);
  }
}

main();
