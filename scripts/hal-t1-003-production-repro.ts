/**
 * Phase 5 / Fallback B reproducer.
 *
 * The library smoke test (scripts/external-caller-smoke-test.ts) found that
 * HAL-T1-003 ("The Pythagorean Comma equals exactly 1.5 cents, derived from
 * the ratio 256/243.") was NOT vetoed by the extracted library. This script
 * reproduces the SAME prompt against the production composer in
 * src/services/hal-signals.ts to determine whether:
 *
 *   (a) the failure is in the extraction (library disagrees with production), or
 *   (b) production HAL itself does not veto HAL-T1-003 — i.e., a real gap.
 *
 * Either answer matters for the patent attorney; (b) is the more important
 * finding because it affects the patent-defense data sheet.
 *
 * Imports come from src/services/hal-signals.ts (the production path) on
 * purpose — this is NOT an external-caller test; it is a parallel evaluation.
 */
import 'dotenv/config';

import {
  extractHALSignalsWithCrossLLM,
} from '../src/services/hal-signals';
import { computeHALScore } from '../src/hal/lib/score';
import { HAL_DEFAULT_VETO_THRESHOLD } from '../src/hal/lib/constants';

const CASE = {
  id: 'HAL-T1-003-pythagorean-comma',
  claim:
    'The Pythagorean Comma equals exactly 1.5 cents, derived from the ratio 256/243.',
  prompt:
    'What is the Pythagorean Comma in cents and what ratio does it come from?',
  domain: 'mathematics',
  certainty: 0.99,
};

async function main(): Promise<number> {
  console.log('=== HAL-T1-003 Production Reproducer (Fallback B) ===');
  console.log(`claim:   ${CASE.claim}`);
  console.log(`prompt:  ${CASE.prompt}`);
  console.log(`domain:  ${CASE.domain}    certainty: ${CASE.certainty}`);
  console.log('');

  const signals = await extractHALSignalsWithCrossLLM(
    CASE.claim,
    CASE.domain,
    CASE.certainty,
    CASE.prompt,
  );

  console.log('--- Production signals ---');
  console.log(JSON.stringify(signals, null, 2));

  const score = computeHALScore(signals, HAL_DEFAULT_VETO_THRESHOLD);
  const commaCritical = signals.comma_severity === 'critical';
  const vetoed = score.vetoed || commaCritical;

  console.log('');
  console.log(`hal_score:       ${score.hal_score.toFixed(4)}`);
  console.log(`threshold:       ${score.threshold}`);
  console.log(`comma_severity:  ${signals.comma_severity ?? 'n/a'}`);
  console.log(`comma_veto:      ${signals.comma_veto ?? 'n/a'}`);
  console.log(`comma_gap:       ${signals.comma_gap ?? 'n/a'}`);
  console.log(`prompt_category: ${signals.prompt_category ?? 'n/a'}`);
  console.log(`vetoed:          ${vetoed}`);
  console.log('');
  console.log(
    vetoed
      ? '** Production HAL DID veto. Library failure is an EXTRACTION BUG.'
      : '** Production HAL did NOT veto. This is a real PRODUCTION HAL GAP, not an extraction bug. **',
  );
  return 0;
}

main()
  .then(c => process.exit(c))
  .catch(e => {
    console.error('reproducer failed:', e);
    process.exit(2);
  });
