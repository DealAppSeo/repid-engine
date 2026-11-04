import { learningCurve, defaultLearningCurveOpts } from '../learning-curve';
import { ConfCorrectPair } from '../calibration';

// Helper: n pairs all with the same (confidence, correct).
const block = (n: number, confidence: number, correct: 0 | 1): ConfCorrectPair[] =>
  Array.from({ length: n }, () => ({ confidence, correct }));

describe('learningCurve', () => {
  it('flags LEARNING when late-window calibration beats the early baseline', () => {
    // early: confident(1.0) but always wrong → ECE 1. late: confident(1.0) and always right → ECE 0.
    const pairs = [...block(25, 1, 0), ...block(25, 1, 1)];
    const v = learningCurve('deepseek', pairs);
    expect(v.insufficient).toBe(false);
    expect(v.baselineEce).toBeCloseTo(1, 6);
    expect(v.currentEce).toBeCloseTo(0, 6);
    expect(v.improvement).toBeCloseTo(1, 6);
    expect(v.learning).toBe(true);
    expect(v.regressing).toBe(false);
    expect(v.selfCredential).toBeGreaterThan(1); // reward improving on your own past
  });

  it('flags REGRESSING when calibration decays over time', () => {
    const pairs = [...block(25, 1, 1), ...block(25, 1, 0)];
    const v = learningCurve('deepseek', pairs);
    expect(v.learning).toBe(false);
    expect(v.regressing).toBe(true);
    expect(v.improvement).toBeCloseTo(-1, 6);
    expect(v.selfCredential).toBeLessThan(1); // shaved toward the floor
  });

  it('ORDER matters: reversing the same pairs flips the verdict', () => {
    const pairs = [...block(25, 1, 0), ...block(25, 1, 1)];
    const fwd = learningCurve('x', pairs);
    const rev = learningCurve('x', [...pairs].reverse());
    expect(fwd.learning).toBe(true);
    expect(rev.regressing).toBe(true);
  });

  it('is NEUTRAL on a flat curve (no real change → no reward/punish)', () => {
    const pairs = [...block(25, 1, 1), ...block(25, 1, 1)];
    const v = learningCurve('x', pairs);
    expect(v.improvement).toBeCloseTo(0, 6);
    expect(v.learning).toBe(false);
    expect(v.regressing).toBe(false);
    expect(v.selfCredential).toBe(1);
  });

  it('refuses a verdict on thin windows (insufficient → neutral credential)', () => {
    const pairs = [...block(5, 1, 0), ...block(5, 1, 1)]; // 5 per window < minWindow 20
    const v = learningCurve('x', pairs);
    expect(v.insufficient).toBe(true);
    expect(v.learning).toBe(false);
    expect(v.regressing).toBe(false);
    expect(v.selfCredential).toBe(1);
  });

  it('respects a custom split fraction', () => {
    const o = { ...defaultLearningCurveOpts(), splitFraction: 0.8, minWindow: 10 };
    const pairs = [...block(40, 1, 0), ...block(10, 1, 1)]; // 80/20 split → early 40 wrong, late 10 right
    const v = learningCurve('x', pairs, o);
    expect(v.nEarly).toBe(40);
    expect(v.nLate).toBe(10);
    expect(v.learning).toBe(true);
  });
});
