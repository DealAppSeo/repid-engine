/**
 * Wave 5 Phase 4 — three-zone Pythagorean Comma agreement classification.
 *
 * Replaces the single-threshold "consensus above X = trust" check with a
 * banded classification:
 *   - too-tight  → suspicious tight collapse (tampering signal at level 5)
 *   - in-band    → trusted consensus (proceeds to claim comparison at L4+)
 *   - too-loose  → uncertainty
 *
 * Wired only at strictness level 4+ in evaluate.ts. Level 3 keeps the
 * existing gap-based COMMA_BFT_THRESHOLDS critical-veto path (preserves
 * byte-identical pre-Wave-5 production behavior — hard-rule #4).
 */
import {
  COMMA_BAND_LOOSE_THRESHOLD,
  COMMA_BAND_TIGHT_THRESHOLD,
} from './constants';
import type { AgreementZone } from './types';

/**
 * Classify a normalized agreement score (0-1) into one of three zones
 * around the Pythagorean Comma.
 */
export function classifyAgreementZone(similarity: number, commaOverride?: number): AgreementZone {
  if (!Number.isFinite(similarity)) return 'too-loose';
  
  let tightThreshold = COMMA_BAND_TIGHT_THRESHOLD;
  let looseThreshold = COMMA_BAND_LOOSE_THRESHOLD;

  if (commaOverride !== undefined) {
    // Dynamic band based on override:
    // Normalized to similarity scale = 1 / comma
    // tight = (1 / comma) + (0.99 - 0.9865) -> roughly (1 / comma) + 0.0035
    // Actually, the simplest is to just use 1/comma directly and maybe shift the original constants by the diff
    const originalNormalized = 1 / 1.0136433;
    const newNormalized = 1 / commaOverride;
    const diff = newNormalized - originalNormalized;
    tightThreshold = COMMA_BAND_TIGHT_THRESHOLD + diff;
    looseThreshold = COMMA_BAND_LOOSE_THRESHOLD + diff;
  }

  if (similarity > tightThreshold) return 'too-tight';
  if (similarity >= looseThreshold) return 'in-band';
  return 'too-loose';
}
