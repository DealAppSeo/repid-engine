/**
 * ANFIS-Ikigai v0.1 — Circle-of-Fifths Harmonic Alignment
 *
 * Treats the four ikigai dimensions as four positions on a circle in this
 * fixed canonical order:
 *
 *     love → good_at → world_needs → paid_for → (back to love)
 *
 * Adjacent positions are "perfect fifths apart" in the musical analogue —
 * resonant when their alignment scores are similar, dissonant when they
 * diverge. A signal that scores 0.9 on love but 0.1 on good_at exhibits
 * structural dissonance: high purpose, low capability — a real architectural
 * pattern in PurposeHub's data model, not just a number.
 *
 * Patent note (P-014 §3.5): applying the Pythagorean Comma constant
 * (531441/524288 ≈ 1.0136433) to the composite score on dissonance is
 * the cross-domain reuse of the same dissonance amplifier HAL v1 uses
 * for hallucination detection. Single mathematical primitive, two
 * different decision surfaces — this *is* the patent claim.
 */

export const PYTHAGOREAN_COMMA = 531441 / 524288;        // ≈ 1.0136433
export const DEFAULT_DISSONANCE_THRESHOLD = 0.0136;       // ≈ comma - 1, matches HAL v1 veto math
export const DEFAULT_PERFECT_FIFTH_RATIO = 1.5;            // 3:2 — for v1 documentation only

export interface DimensionScores {
  love: number;
  good_at: number;
  world_needs: number;
  paid_for: number;
}

export interface HarmonicAlignment {
  /** Dissonance between love and good_at, normalised to [0, 1]. */
  love_good_at_distance: number;
  good_at_world_needs_distance: number;
  world_needs_paid_for_distance: number;
  paid_for_love_distance: number;
  /** 1 - mean(distances). 1.0 = all four dimensions in perfect harmony. */
  resonance_score: number;
  /** True when ANY adjacent pair exceeds the dissonance threshold. */
  dissonance_flag: boolean;
  /** Constant 1.0136433 — applied to composite when dissonance_flag fires. */
  pythagorean_comma_multiplier: number;
  /**
   * The composite-score adjustment factor the caller should apply.
   *   - dissonance_flag === false → 1.0 (unchanged)
   *   - dissonance_flag === true  → PYTHAGOREAN_COMMA
   * Caller multiplies its v0 composite by this factor to amplify the
   * dissonance signal in the final score.
   */
  composite_multiplier: number;
}

export interface HarmonicOptions {
  /** Override the dissonance threshold; defaults to 0.0136. */
  dissonance_threshold?: number;
}

/**
 * Compute pairwise harmonic distance for one adjacency.
 *
 *     distance = |a - b| / max(a, b, ε)
 *
 * The denominator-with-max stops a "low love + low good_at" pair from
 * registering as huge dissonance just because both scores are tiny. ε
 * keeps zero/zero finite (returns 0 — two zeros are perfectly harmonic).
 */
function adjacentDistance(a: number, b: number): number {
  const eps = 1e-6;
  const denom = Math.max(a, b, eps);
  if (denom <= eps) return 0;
  const d = Math.abs(a - b) / denom;
  if (Number.isNaN(d)) return 0;
  if (d < 0) return 0;
  if (d > 1) return 1;
  return d;
}

export function computeHarmonicAlignment(
  scores: DimensionScores,
  options: HarmonicOptions = {},
): HarmonicAlignment {
  const threshold = options.dissonance_threshold ?? DEFAULT_DISSONANCE_THRESHOLD;

  const lvg = adjacentDistance(scores.love,        scores.good_at);
  const gvw = adjacentDistance(scores.good_at,     scores.world_needs);
  const wvp = adjacentDistance(scores.world_needs, scores.paid_for);
  const pvl = adjacentDistance(scores.paid_for,    scores.love);

  const meanDist = (lvg + gvw + wvp + pvl) / 4;
  const resonance = clamp01(1 - meanDist);

  const dissonanceFlag =
    lvg > threshold ||
    gvw > threshold ||
    wvp > threshold ||
    pvl > threshold;

  return {
    love_good_at_distance:        round4(lvg),
    good_at_world_needs_distance: round4(gvw),
    world_needs_paid_for_distance: round4(wvp),
    paid_for_love_distance:       round4(pvl),
    resonance_score:              round4(resonance),
    dissonance_flag:              dissonanceFlag,
    pythagorean_comma_multiplier: PYTHAGOREAN_COMMA,
    composite_multiplier:         dissonanceFlag ? PYTHAGOREAN_COMMA : 1.0,
  };
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
