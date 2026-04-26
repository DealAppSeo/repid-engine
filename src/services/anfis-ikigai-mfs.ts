/**
 * ANFIS-Ikigai — Triangular Membership Functions (v0)
 *
 * Maps a raw 0-1 signal-vs-dimension alignment score into degrees of
 * belonging to three fuzzy sets per ikigai dimension: low / medium / high.
 *
 * v0 uses fixed triangular MFs because:
 *   - they are computationally trivial (one branch, two subtractions);
 *   - their semantics ("peak at X, zero outside [X-w, X+w]") are easy to
 *     explain to a patent attorney and easy to verify by inspection;
 *   - they produce smooth, monotonic firing strengths that play well with
 *     a Sugeno consequent.
 *
 * v1 candidates (do NOT introduce here):
 *   - Gaussian MFs once we have enough labelled feedback to fit width.
 *   - Trapezoidal MFs to encode a "satisficing band" on paid_for.
 *   - Per-dimension MF parameters learned end-to-end (PPO-ANFIS pattern).
 *
 * Patent note (P-014): the MF parameters themselves are part of the
 * ikigai-grounded reward function. Documenting them as v0 defaults makes
 * them concrete embodiment for reduction-to-practice.
 */

export type IkigaiDimension =
  | 'love'
  | 'good_at'
  | 'world_needs'
  | 'paid_for';

export type FuzzySet = 'low' | 'medium' | 'high';

export interface TriangularMfParams {
  /** Left foot of the triangle — where membership starts rising from 0. */
  leftBase: number;
  /** Peak of the triangle — where membership is exactly 1. */
  peak: number;
  /** Right foot — where membership returns to 0. */
  rightBase: number;
}

/**
 * v0 default MF parameters. We use shoulder semantics on the boundary fuzzy
 * sets so the natural extreme values (0 and 1) saturate correctly:
 *
 *   - low:    peak === leftBase (both 0.0) → left shoulder. Membership is 1
 *             at x ≤ 0 and ramps down to 0 at x = 0.4.
 *   - medium: pure isoceles triangle peaking at 0.5.
 *   - high:   peak === rightBase (both 1.0) → right shoulder. Membership is
 *             1 at x ≥ 1 and ramps down (left edge) to 0 at x = 0.6.
 *
 * Rationale: a strict triangular MF on [0.6, 0.8, 1.0] returns membership 0
 * at x = 1.0 — meaning the *most aligned possible signal* would be classed
 * outside the "high" set, breaking every rule that depends on it. The
 * shoulder formulation is the standard fix in production ANFIS systems for
 * the boundary fuzzy sets (Jang 1993; ANFIS toolboxes default to it).
 *
 * The geometry is still triangular; only the corner is squared off. v1
 * candidates remain Gaussian or trapezoidal once labelled data is in.
 */
export const V0_TRIANGULAR_MFS: Record<FuzzySet, TriangularMfParams> = {
  low:    { leftBase: 0.0, peak: 0.0, rightBase: 0.4 },
  medium: { leftBase: 0.3, peak: 0.5, rightBase: 0.7 },
  high:   { leftBase: 0.6, peak: 1.0, rightBase: 1.0 },
};

/**
 * Triangular (and shouldered-triangular) MF evaluation.
 *
 * Returns the degree of belonging of `x` to the named fuzzy set, in [0, 1].
 *
 *   - x outside [leftBase, rightBase]                   → 0
 *   - peak === leftBase  AND x ≤ peak (left shoulder)   → 1
 *   - peak === rightBase AND x ≥ peak (right shoulder)  → 1
 *   - x === peak (pure triangle)                        → 1
 *   - leftBase < x < peak                               → rising linear ramp
 *   - peak < x < rightBase                              → falling linear ramp
 *
 * Determinism: pure function, identical input → identical output.
 */
export function membershipScore(
  _dimension: IkigaiDimension,  // currently dim-agnostic; reserved for v1
  rawSignalScore: number,
  fuzzySet: FuzzySet,
): number {
  const x = clamp01(rawSignalScore);
  const params = V0_TRIANGULAR_MFS[fuzzySet];
  const { leftBase, peak, rightBase } = params;

  if (x < leftBase) return 0;
  if (x > rightBase) return 0;

  // Right-shoulder: peak coincides with the right base, full membership for
  // any x at or above the peak.
  if (peak === rightBase && x >= peak) return 1;
  // Left-shoulder: peak coincides with the left base.
  if (peak === leftBase && x <= peak) return 1;

  if (x === peak) return 1;

  if (x < peak) {
    // Rising edge: width is (peak - leftBase), value is (x - leftBase) / width.
    const width = peak - leftBase;
    return width > 0 ? (x - leftBase) / width : 0;
  }

  // Falling edge: width is (rightBase - peak), value is (rightBase - x) / width.
  const width = rightBase - peak;
  return width > 0 ? (rightBase - x) / width : 0;
}

/**
 * Convenience: compute all three fuzzy-set memberships for a single raw
 * score. Useful for the rule engine, which fans across {low, medium, high}.
 */
export function membershipTriple(
  dimension: IkigaiDimension,
  rawSignalScore: number,
): Record<FuzzySet, number> {
  return {
    low:    membershipScore(dimension, rawSignalScore, 'low'),
    medium: membershipScore(dimension, rawSignalScore, 'medium'),
    high:   membershipScore(dimension, rawSignalScore, 'high'),
  };
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}
