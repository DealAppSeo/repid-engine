/**
 * Wisdom-scale normalization + delta backstop (2026-07-30).
 *
 * Live-prod finding: repid_agents.wisdom_score carries three scale
 * conventions (1.0 / 0-100 DB-default / canonical 1000-centered), and the
 * reward formula's exponential wisdom factor read it RAW — φ^49 ≈ 1.7e10 →
 * reward ≈ 4e11 → int4 overflow on repid_score_events.delta → the whole
 * Track-A scoring path 500'd for 104 of 161 agents (every fresh
 * registration included; verified by SQL + local reproduction).
 *
 * These tests pin: every observed prod value maps to a bounded formula-scale
 * input; each scale's NEUTRAL point maps to exactly 1.0; and the delta
 * backstop keeps any future factor explosion inside the score-range width.
 * The final test proves the actual end-to-end property: calculateFullReward
 * over every observed prod wisdom value now yields an int4-safe delta.
 */
import {
  normalizeWisdomForReward,
  clampEventDelta,
  WISDOM_FORMULA_MIN,
  WISDOM_FORMULA_MAX,
  MAX_ABS_EVENT_DELTA,
} from '../src/services/wisdom-normalize';
import { calculateFullReward } from '../src/reward-formula';

describe('normalizeWisdomForReward', () => {
  test('neutral points of all three conventions map to exactly 1.0', () => {
    expect(normalizeWisdomForReward(1.0)).toEqual({ value: 1.0, interpretedAs: 'formula_1x', adjusted: false });
    expect(normalizeWisdomForReward(50.0).value).toBe(1.0); // DB default
    expect(normalizeWisdomForReward(1000).value).toBe(1.0); // canonical calibration
  });

  test('observed prod extremes stay bounded', () => {
    // 1500 was live in prod (φ^1499 = Infinity if read raw).
    const fifteenHundred = normalizeWisdomForReward(1500);
    expect(fifteenHundred.value).toBe(1.5);
    expect(fifteenHundred.interpretedAs).toBe('calibration_1000');
    // Absurd future values clamp to the ceiling instead of exploding.
    expect(normalizeWisdomForReward(1e9).value).toBe(WISDOM_FORMULA_MAX);
    expect(normalizeWisdomForReward(200).value).toBe(WISDOM_FORMULA_MAX); // 200/50=4 → clamp 2
  });

  test('formula-scale values pass through, clamped to [0.5, 2.0]', () => {
    expect(normalizeWisdomForReward(1.4).value).toBe(1.4);
    expect(normalizeWisdomForReward(0.1).value).toBe(WISDOM_FORMULA_MIN);
    expect(normalizeWisdomForReward(2.0).value).toBe(2.0);
  });

  test('invalid inputs default to neutral 1.0, flagged adjusted', () => {
    for (const bad of [null, undefined, NaN, -5, 0, 'garbage', Infinity]) {
      const r = normalizeWisdomForReward(bad as any);
      expect(r.value).toBe(1.0);
      expect(r.adjusted).toBe(true);
    }
    // Numeric strings (Supabase returns numeric columns as strings) parse.
    expect(normalizeWisdomForReward('50.0').value).toBe(1.0);
    expect(normalizeWisdomForReward('1000').value).toBe(1.0);
  });
});

describe('clampEventDelta', () => {
  test('sane deltas pass through rounded', () => {
    expect(clampEventDelta(23.56)).toEqual({ delta: 24, clamped: false });
    expect(clampEventDelta(-9)).toEqual({ delta: -9, clamped: false });
  });

  test('the live overflow value is bounded to the score-range width', () => {
    expect(clampEventDelta(322194662852)).toEqual({ delta: MAX_ABS_EVENT_DELTA, clamped: true });
    expect(clampEventDelta(-4e11)).toEqual({ delta: -MAX_ABS_EVENT_DELTA, clamped: true });
  });

  test('non-finite rewards become delta 0, never a crash', () => {
    expect(clampEventDelta(Infinity)).toEqual({ delta: 0, clamped: true });
    expect(clampEventDelta(NaN)).toEqual({ delta: 0, clamped: true });
  });
});

describe('end-to-end property: reward over every observed prod wisdom value is int4-safe', () => {
  // The exact inputs the route builds for a fresh external agent (repid 200,
  // certainty 0.9 → baseDelta 9), with phi/impactCap at live prod config
  // values (verified 2026-07-30: phi=1.618033988749895, impact_factor_cap=5).
  function routeInputs(wisdomRaw: unknown) {
    return {
      baseDelta: 9,
      isValidator: true,
      impactUSDC: 0,
      domainAccuracy: 1.0,
      alignmentExponent: 1.0,
      challengerRepID: 200,
      targetRepID: 200,
      collusionRisk: 0,
      isExploration: false,
      isGenesis: false,
      wisdomScore: normalizeWisdomForReward(wisdomRaw).value,
      informationParity: 1.0,
      daysAsNewDBT: 999,
      vdrCount: 0,
      latencyPenalty: 1.0,
      keystoneFactor: 1.0,
      mentorshipBonus: 1.0,
      confessionFactor: 1.0,
      isHuman: false,
    } as any;
  }

  test.each([1.0, 50.0, 1000, 1500, 1e6, null])('wisdom_score=%p', (raw) => {
    const r = calculateFullReward(routeInputs(raw), 1.618033988749895, 5);
    const { delta, clamped } = clampEventDelta(r.reward);
    expect(Number.isFinite(delta)).toBe(true);
    expect(Math.abs(delta)).toBeLessThanOrEqual(MAX_ABS_EVENT_DELTA);
    // With normalization the clamp backstop should not even be needed:
    expect(clamped).toBe(false);
    // int4 safety — the exact failure mode that broke prod.
    expect(Math.abs(delta)).toBeLessThan(2147483647);
  });
});
