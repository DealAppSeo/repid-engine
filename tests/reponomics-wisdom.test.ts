/**
 * Reponomics — wisdom score (Pythagorean Comma calibration) tests.
 *
 * Pure helper computeNewWisdom is exercised directly. The DB-backed
 * updateWisdomScore path is covered by integration tests; here we
 * confirm the math at the boundary points.
 */

import {
  computeNewWisdom,
  PYTHAGOREAN_COMMA,
  COMMA_THRESHOLD,
  W_FLOOR,
  W_CEILING,
} from '../src/services/wisdom-score';

describe('wisdom-score — Pythagorean Comma calibration math', () => {
  it('calibration error 0.05 (above comma threshold) fires the comma penalty', () => {
    const r = computeNewWisdom(1000, 0.05);
    expect(r.commaApplied).toBe(true);
    // 1000 / 1.0136433 ≈ 986.55 → floor 986
    expect(r.newWisdom).toBeGreaterThanOrEqual(985);
    expect(r.newWisdom).toBeLessThanOrEqual(987);
  });

  it('calibration error 0.005 (below threshold) fires the small reward', () => {
    const r = computeNewWisdom(1000, 0.005);
    expect(r.commaApplied).toBe(false);
    expect(r.newWisdom).toBe(Math.floor(1000 * 1.001));
  });

  it('exactly at threshold does NOT fire (strict >)', () => {
    const r = computeNewWisdom(1000, COMMA_THRESHOLD);
    expect(r.commaApplied).toBe(false);
  });

  it('floor enforced — repeated penalty cannot go below 100', () => {
    let cur = 110;
    for (let i = 0; i < 50; i++) {
      cur = computeNewWisdom(cur, 0.5).newWisdom;
    }
    expect(cur).toBe(W_FLOOR);
  });

  it('ceiling enforced — repeated reward cannot exceed 2000', () => {
    let cur = 1990;
    for (let i = 0; i < 50; i++) {
      cur = computeNewWisdom(cur, 0.001).newWisdom;
    }
    expect(cur).toBe(W_CEILING);
  });

  it('Pythagorean Comma constant matches the spec value', () => {
    expect(PYTHAGOREAN_COMMA).toBeCloseTo(1.0136433, 7);
    expect(PYTHAGOREAN_COMMA).toBeCloseTo(531441 / 524288, 7);
  });
});
