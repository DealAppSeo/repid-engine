/**
 * HAL score computation — the canonical Path A formula. Pure function,
 * dependency-free.
 *
 * NOT a stub: this is the real scoring math. The formula has been stable
 * since the 2026-05-03 cross-LLM verification merge (commit `d8915e43`)
 * and is patent-load-bearing per HAL_LIBRARY_API.md. Phase 3 callers
 * (extracted hal-signals, /score-event, /api/v1/hal/signals) will route
 * through this function so there's exactly one implementation.
 */
import {
  HAL_FORMULA_WEIGHTS,
  HAL_PYTHAGOREAN_COMMA,
  HAL_DEFAULT_VETO_THRESHOLD,
} from './constants';
import type { HALSignals } from './types';

export interface HALScoreOutput {
  hal_score: number;
  vetoed: boolean;
  threshold: number;
  formula: string;
}

/**
 * Compute hal_score from the 5-signal block.
 *
 *   hal_score = (
 *       0.4 * harm_probability
 *     + 0.3 * epistemic_uncertainty
 *     + 0.2 * (1 - evidence_quality)
 *     + 0.1 * (1 - scope_appropriateness)
 *   ) * (531441/524288)
 *
 * Veto: hal_score >= threshold (default 0.25). The constitutional-block
 * threshold (0.48 in /score-event) is a higher gate evaluated by
 * downstream consumers, not by this function.
 */
export function computeHALScore(
  signals: HALSignals,
  threshold: number = HAL_DEFAULT_VETO_THRESHOLD,
  commaOverride?: number
): HALScoreOutput {
  const w = HAL_FORMULA_WEIGHTS;
  const comma = commaOverride !== undefined ? commaOverride : HAL_PYTHAGOREAN_COMMA;
  let sum = 0;
  if (typeof signals.agreement_score === 'number' && signals.agreement_score !== null) {
    sum = 
      0.35 * signals.harm_probability +
      0.25 * signals.epistemic_uncertainty +
      0.15 * (1 - signals.evidence_quality) +
      0.05 * (1 - signals.scope_appropriateness) +
      0.20 * (1 - signals.agreement_score);
  } else {
    sum = 
      w.harm * signals.harm_probability +
      w.epistemic * signals.epistemic_uncertainty +
      w.evidence * (1 - signals.evidence_quality) +
      w.scope * (1 - signals.scope_appropriateness);
  }

  // Ensure hard [0, 1] bound BEFORE multiplication
  const normalizedSum = Math.max(0, Math.min(1, sum));
  
  // Normalize final score to [0, 1] after Comma multiplication
  const hal_score = Math.min(1, normalizedSum * comma);

  return {
    hal_score,
    vetoed: hal_score >= threshold,
    threshold,
    formula: 'hal-canonical-v1',
  };
}
