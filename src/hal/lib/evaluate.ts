/**
 * Top-level HAL evaluation entry point. STUB until Phase 5.
 *
 * Composes:
 *   1. extractHALSignals (Phase 3) → 5-signal block
 *   2. classify (Phase 4, optional) → prompt category gate
 *   3. checkCrossLLM (Phase 4, optional) → Layer 1 agreement + Comma BFT
 *   4. computeHALScore (already real) → final hal_score + vetoed
 *
 * If `context.providers` is empty/undefined, the cross-LLM path is
 * skipped and the result has `cross_llm: null`.
 *
 * If `context.prompt` is omitted, the classifier path is skipped too.
 *
 * The final `vetoed` is `(hal_score >= threshold) || (comma_severity === 'critical')`.
 */
import type { HALContext, HALResult } from './types';

export async function evaluate(
  _claimText: string,
  _output: string,
  _context: HALContext,
): Promise<HALResult> {
  throw new Error('evaluate.evaluate not yet implemented — Phase 5 of HAL extraction sprint');
}
