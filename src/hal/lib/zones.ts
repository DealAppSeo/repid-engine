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
export function classifyAgreementZone(similarity: number): AgreementZone {
  if (!Number.isFinite(similarity)) return 'too-loose';
  if (similarity > COMMA_BAND_TIGHT_THRESHOLD) return 'too-tight';
  if (similarity >= COMMA_BAND_LOOSE_THRESHOLD) return 'in-band';
  return 'too-loose';
}
