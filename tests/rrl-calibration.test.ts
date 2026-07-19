/**
 * Unit tests for the RRL per-provider calibration layer (src/rrl/calibration.ts).
 * Covers: ECE definition, isotonic monotonicity, small-sample shrinkage + identity fallback,
 * known-input correction, out-of-sample K-fold, and the incentive-preserving credentials.
 * Pure + deterministic — no RNG, no I/O.
 */
import {
  binIndex,
  clamp01,
  expectedCalibrationError,
  poolAdjacentViolators,
  fitReliabilityCurve,
  applyCalibration,
  makeCalibrator,
  kFoldEce,
  relativeCalibrationCredential,
  selfBaselineCredential,
  defaultCalibrationConfig,
  type ConfCorrectPair,
} from '../src/rrl/calibration';

/** Deterministic synthetic provider: n answers at a fixed stated confidence, exact accuracy. */
function fixedConfProvider(conf: number, n: number, accuracy: number): ConfCorrectPair[] {
  const out: ConfCorrectPair[] = [];
  const nCorrect = Math.round(n * accuracy);
  for (let i = 0; i < n; i++) out.push({ confidence: conf, correct: (i < nCorrect ? 1 : 0) as 0 | 1 });
  return out;
}

describe('helpers', () => {
  test('clamp01 bounds', () => {
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(1.4)).toBe(1);
    expect(clamp01(0.37)).toBeCloseTo(0.37, 10);
  });

  test('binIndex maps to [0, nBins-1], 1.0 lands in last bin', () => {
    expect(binIndex(0.0, 10)).toBe(0);
    expect(binIndex(0.64, 10)).toBe(6);
    expect(binIndex(1.0, 10)).toBe(9);
    expect(binIndex(1.5, 10)).toBe(9);
  });

  test('ECE = 0 for perfectly calibrated, and equals the gap for a single mis-calibrated bin', () => {
    // all at conf 0.9, exactly 90% correct -> perfectly calibrated -> ECE 0
    const good = fixedConfProvider(0.9, 100, 0.9);
    expect(expectedCalibrationError(good, 10)).toBeCloseTo(0, 6);
    // all at conf 0.9, only 50% correct -> ECE = |0.9 - 0.5| = 0.4
    const bad = fixedConfProvider(0.9, 100, 0.5);
    expect(expectedCalibrationError(bad, 10)).toBeCloseTo(0.4, 6);
  });

  test('ECE on empty input fails loud (returns 1)', () => {
    expect(expectedCalibrationError([], 10)).toBe(1);
  });
});

describe('poolAdjacentViolators — isotonic monotonicity', () => {
  test('non-decreasing output, same length', () => {
    const vals = [0.9, 0.1, 0.5, 0.2, 0.8];
    const w = [1, 1, 1, 1, 1];
    const out = poolAdjacentViolators(vals, w);
    expect(out).toHaveLength(vals.length);
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThanOrEqual(out[i - 1]! - 1e-12);
  });

  test('already-monotone input is unchanged', () => {
    const vals = [0.1, 0.3, 0.3, 0.7, 0.9];
    const out = poolAdjacentViolators(vals, [1, 1, 1, 1, 1]);
    out.forEach((v, i) => expect(v).toBeCloseTo(vals[i]!, 10));
  });

  test('weighted PAV preserves the total weighted mean', () => {
    const vals = [0.9, 0.1, 0.5];
    const w = [2, 5, 3];
    const out = poolAdjacentViolators(vals, w);
    const wmeanIn = vals.reduce((s, v, i) => s + v * w[i]!, 0) / w.reduce((a, b) => a + b, 0);
    const wmeanOut = out.reduce((s, v, i) => s + v * w[i]!, 0) / w.reduce((a, b) => a + b, 0);
    expect(wmeanOut).toBeCloseTo(wmeanIn, 10);
  });
});

describe('fitReliabilityCurve — monotonicity of the calibrated map', () => {
  test('calibrated[] is non-decreasing even when raw bin accuracies are NOT', () => {
    // Construct a provider whose empirical bin-accuracy is non-monotone in confidence:
    // low-conf answers happen to be MORE accurate than mid-conf ones.
    const pairs: ConfCorrectPair[] = [
      ...fixedConfProvider(0.15, 40, 0.9), // low conf, high accuracy
      ...fixedConfProvider(0.45, 40, 0.2), // mid conf, low accuracy
      ...fixedConfProvider(0.85, 40, 0.6), // high conf, mid accuracy
    ];
    const curve = fitReliabilityCurve('nonmono', pairs);
    expect(curve.identity).toBe(false);
    for (let i = 1; i < curve.calibrated.length; i++) {
      expect(curve.calibrated[i]!).toBeGreaterThanOrEqual(curve.calibrated[i - 1]! - 1e-12);
    }
    // applyCalibration is therefore monotone in raw confidence
    let prev = -1;
    for (let c = 0; c <= 1.0001; c += 0.05) {
      const v = applyCalibration(curve, Math.min(c, 1));
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });
});

describe('fitReliabilityCurve — small-sample handling', () => {
  test('below minSamples the curve is the IDENTITY map (no correction)', () => {
    const cfg = defaultCalibrationConfig(); // minSamples = 30
    const tiny = fixedConfProvider(0.95, 12, 0.5); // n=12 < 30
    const curve = fitReliabilityCurve('tiny', tiny, cfg);
    expect(curve.identity).toBe(true);
    // identity => applyCalibration returns the raw confidence unchanged
    expect(applyCalibration(curve, 0.95)).toBeCloseTo(0.95, 10);
    expect(applyCalibration(curve, 0.3)).toBeCloseTo(0.3, 10);
  });

  test('a THIN bin is shrunk toward the prior, not stuck at its raw empirical accuracy', () => {
    // Prior is high (~0.9). A single wrong answer at 0.65 has raw empirical accuracy 0.0;
    // shrinkage must pull its calibrated value UP toward the prior, well above 0.
    const pairs: ConfCorrectPair[] = [
      ...fixedConfProvider(0.95, 90, 0.95), // establishes a high prior + a dense bin
      { confidence: 0.65, correct: 0 }, // the lone thin-bin sample, raw acc = 0
    ];
    const curve = fitReliabilityCurve('thin', pairs);
    expect(curve.identity).toBe(false);
    const thinBinVal = applyCalibration(curve, 0.65);
    expect(thinBinVal).toBeGreaterThan(0.4); // pulled toward the ~0.9 prior, not left at 0
  });

  test('MORE data in a bin => calibrated value tracks empirical MORE closely (less shrinkage)', () => {
    // Same low empirical accuracy (0) in the target bin; only the sample count differs.
    const prior = fixedConfProvider(0.95, 120, 0.92); // shared high-prior context
    const sparse = fitReliabilityCurve('sparse', [...prior, ...fixedConfProvider(0.35, 2, 0)]);
    const dense = fitReliabilityCurve('dense', [...prior, ...fixedConfProvider(0.35, 60, 0)]);
    const sparseVal = applyCalibration(sparse, 0.35);
    const denseVal = applyCalibration(dense, 0.35);
    // With more evidence that the 0.35 bin is wrong, its calibrated prob is pulled DOWN closer
    // to the empirical 0 than the sparse (heavily-shrunk) case.
    expect(denseVal).toBeLessThan(sparseVal);
  });
});

describe('known-input correction', () => {
  test('overconfident provider (says 0.9, right 50%) recalibrates toward ~0.5 and ECE collapses', () => {
    const pairs = fixedConfProvider(0.9, 100, 0.5);
    const rawEce = expectedCalibrationError(pairs, 10);
    expect(rawEce).toBeGreaterThan(0.3);

    const curve = fitReliabilityCurve('over', pairs);
    const cal = makeCalibrator(curve);
    expect(cal(0.9)).toBeCloseTo(0.5, 1); // pulled from 0.9 toward the realised 0.5

    const recal = pairs.map((p) => ({ confidence: clamp01(cal(p.confidence)), correct: p.correct }));
    expect(expectedCalibrationError(recal, 10)).toBeLessThan(0.05);
  });

  test('fit is deterministic (same input => byte-identical curve)', () => {
    const pairs = fixedConfProvider(0.8, 80, 0.6);
    const a = fitReliabilityCurve('d', pairs);
    const b = fitReliabilityCurve('d', pairs);
    expect(a.calibrated).toEqual(b.calibrated);
    expect(a.prior).toBe(b.prior);
  });
});

describe('kFoldEce — out-of-sample', () => {
  test('OOS ECE beats raw ECE on an overconfident provider and is deterministic', () => {
    // Overconfident but consistent: says 0.95, right ~80% -> a fittable systematic bias.
    const pairs = fixedConfProvider(0.95, 200, 0.8);
    const rawEce = expectedCalibrationError(pairs, 10);
    const oos = kFoldEce(pairs, 5);
    expect(oos).toBeLessThan(rawEce);
    expect(oos).toBeLessThan(0.05);
    expect(kFoldEce(pairs, 5)).toBe(oos); // deterministic
  });

  test('degenerate small n falls back to raw ECE without throwing', () => {
    const pairs = fixedConfProvider(0.9, 3, 0.33);
    expect(() => kFoldEce(pairs, 5)).not.toThrow();
    expect(kFoldEce(pairs, 5)).toBeCloseTo(expectedCalibrationError(pairs, 10), 10);
  });
});

describe('incentive-preserving credentials', () => {
  test('relativeCalibrationCredential rewards better-than-median, shaves worse', () => {
    const peers = [0.05, 0.10, 0.20, 0.20];
    // A well-calibrated provider (ECE below the peer median) keeps its full credential.
    expect(relativeCalibrationCredential(0.03, peers)).toBeCloseTo(1, 6);
    // A poorly-calibrated provider (ECE above median) is shaved toward the floor.
    const worse = relativeCalibrationCredential(0.30, peers);
    expect(worse).toBeLessThan(1);
    expect(worse).toBeGreaterThanOrEqual(0.4); // never below the floor
    // Monotone: worse calibration => lower-or-equal credential.
    expect(relativeCalibrationCredential(0.25, peers)).toBeGreaterThanOrEqual(worse - 1e-12);
  });

  test('relativeCalibrationCredential with no peers is neutral (1)', () => {
    expect(relativeCalibrationCredential(0.3, [])).toBe(1);
  });

  test('selfBaselineCredential rewards improvement, penalises regression, neutral when unchanged', () => {
    expect(selfBaselineCredential(0.1, 0.1)).toBeCloseTo(1, 6); // no change -> neutral (the single-shot case)
    expect(selfBaselineCredential(0.05, 0.20)).toBeGreaterThan(1); // improved -> rewarded (capped)
    expect(selfBaselineCredential(0.30, 0.10)).toBeLessThan(1); // regressed -> shaved
    expect(selfBaselineCredential(0.30, 0.10)).toBeGreaterThanOrEqual(0.4); // floor holds
  });
});
