/**
 * Phase 3 extraction target — currently a STUB.
 *
 * The real implementation lives at src/services/hal-signals.ts:79-151.
 * Phase 3 of the HAL extraction sprint will:
 *   1. Move extractHALSignals() here (with DI for ontologies)
 *   2. Update src/services/hal-signals.ts to re-export from here for
 *      backward compatibility
 *   3. Verify the regression test (tests/hal-regression.test.ts) stays
 *      green with no semantic drift
 *
 * Until Phase 3 lands, calling this throws so production paths can't
 * accidentally route through an empty implementation.
 */
import type { ExtractInput, HALSignals } from './types';

export function extractHALSignals(_input: ExtractInput): HALSignals {
  throw new Error('extract.extractHALSignals not yet implemented — Phase 3 of HAL extraction sprint');
}
