// Wisdom-scale normalization for the reward call site (2026-07-30).
//
// `repid_agents.wisdom_score` carries THREE scale conventions in prod
// (verified live 2026-07-30: 57 rows at exactly 1.0, 104 rows in 50.0–1500):
//   * ~1.0-centered  — the scale calculateFullReward's wisdom factor expects
//                      (factor ≈ φ^(wisdom−1); it is NOT clamped in-formula)
//   * 0–100          — the column's Postgres DEFAULT 50.0, filled on every
//                      external registration (register() never sets it)
//   * 1000-centered  — the canonical calibration scale (agent-creation
//                      STARTING_WISDOM=1000; wisdom-score.ts and the builder
//                      surfaces default `?? 1000`)
//
// Feeding the raw column into the formula is what broke the entire Track-A
// external scoring path: φ^49 ≈ 1.7e10 → reward ≈ 4e11 → int4 overflow on
// repid_score_events.delta → HTTP 500 for ~65% of agents including every new
// registration.
//
// This module fixes the READ, not the formula (the reward formula is a
// hard-stop surface) and not the data (the 1000-scale is canonical for its
// own consumers). Every scale maps to its neutral point → 1.0, and the result
// is clamped to [0.5, 2.0] so the wisdom factor stays within ~[φ^-0.5, φ^1]
// no matter what the column carries in the future. Antifragility rule: a
// poisoned row may cost accuracy on one factor, never the whole scoring path.

/** Bounds for the formula-scale wisdom input. φ^(2-1)=1.618 max boost. */
export const WISDOM_FORMULA_MIN = 0.5;
export const WISDOM_FORMULA_MAX = 2.0;

export interface NormalizedWisdom {
  value: number;
  /** Which convention the raw value was interpreted as. */
  interpretedAs: 'formula_1x' | 'legacy_0_100' | 'calibration_1000' | 'invalid_default';
  /** True when the raw value was rescaled or clamped (loud-log signal). */
  adjusted: boolean;
}

export function normalizeWisdomForReward(raw: unknown): NormalizedWisdom {
  const n = typeof raw === 'string' ? Number(raw) : (raw as number);

  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
    return { value: 1.0, interpretedAs: 'invalid_default', adjusted: true };
  }

  let value: number;
  let interpretedAs: NormalizedWisdom['interpretedAs'];
  if (n <= 2) {
    // Already formula-scale.
    value = n;
    interpretedAs = 'formula_1x';
  } else if (n <= 200) {
    // Legacy 0–100 scale (DB default 50 = neutral).
    value = n / 50;
    interpretedAs = 'legacy_0_100';
  } else {
    // Canonical 1000-centered calibration scale.
    value = n / 1000;
    interpretedAs = 'calibration_1000';
  }

  const clamped = Math.min(WISDOM_FORMULA_MAX, Math.max(WISDOM_FORMULA_MIN, value));
  const adjusted = interpretedAs !== 'formula_1x' || clamped !== n;
  return { value: clamped, interpretedAs, adjusted };
}

/**
 * Int4-safe, score-range-safe bound for a RepID delta about to be persisted.
 * No legitimate single event can move a score by more than the full scale
 * width (10000−10). This is the backstop for ANY future factor explosion —
 * the score event records a sane delta instead of 500ing the whole path.
 */
export const MAX_ABS_EVENT_DELTA = 9990;

export function clampEventDelta(rawDelta: number): { delta: number; clamped: boolean } {
  if (!Number.isFinite(rawDelta)) return { delta: 0, clamped: true };
  const delta = Math.max(-MAX_ABS_EVENT_DELTA, Math.min(MAX_ABS_EVENT_DELTA, Math.round(rawDelta)));
  return { delta, clamped: delta !== Math.round(rawDelta) };
}
