/**
 * HAL CALIBRATION — does hal_score mean what it says?  (RED-FIRST, commit 1)
 *
 * The measurement ruler already makes an F1 carry the population and configuration it was taken at.
 * F1 asks "how often is the veto right?"; it does NOT ask "when HAL says 0.9, does the thing happen
 * 90% of the time?" — that is CALIBRATION. r24 and the TrustMesh Technical paper §7.5 ask measurement
 * integrity to carry a Brier score and reliability curves. These tests pin the pure math and its wiring.
 *
 * Pure throughout: the benchmark path uses a deterministic stub `evaluate` — no provider keys, no network.
 */
import {
  computeCalibration,
  formatCalibration,
  InvalidCalibrationError,
  type CalibrationPoint,
} from '../src/hal/calibration';
import {
  scoreBenchmark,
  scoreBenchmarkRuled,
  manifestForItems,
  type BenchmarkItem,
  type HalEvalLike,
} from '../src/hal/benchmark';
import { ConfigurationWidth, MeasurementRuler } from '../src/hal/measurement-ruler';

/** A calibrated-but-uncertain set: within each bin, meanPredicted === empirical positive rate. */
function perfectlyCalibrated(): CalibrationPoint[] {
  const pts: CalibrationPoint[] = [];
  // predicted 0.5, 4 of 8 positive  -> bin [0.5,0.6): meanP 0.5, meanA 0.5
  for (let i = 0; i < 8; i++) pts.push({ predicted: 0.5, actual: i < 4 ? 1 : 0 });
  // predicted 0.2, 2 of 10 positive -> bin [0.2,0.3): meanP 0.2, meanA 0.2
  for (let i = 0; i < 10; i++) pts.push({ predicted: 0.2, actual: i < 2 ? 1 : 0 });
  // predicted 0.8, 8 of 10 positive -> bin [0.8,0.9): meanP 0.8, meanA 0.8
  for (let i = 0; i < 10; i++) pts.push({ predicted: 0.8, actual: i < 8 ? 1 : 0 });
  return pts; // N = 28
}

describe('computeCalibration — Brier + reliability + ECE (pure)', () => {
  it('a perfectly-calibrated set has ~0 ECE and the exact refinement Brier', () => {
    const rep = computeCalibration(perfectlyCalibrated());
    expect(rep.n).toBe(28);
    expect(rep.bins).toBe(10);
    // ECE is exactly 0: every populated bin has meanPredicted === meanActual.
    expect(rep.expectedCalibrationError).toBeCloseTo(0, 10);
    // Brier is the irreducible refinement term, not 0: 5.2 / 28.
    expect(rep.brier).toBeCloseTo(5.2 / 28, 10);
    expect(rep.brier!).toBeLessThan(0.25); // better than always-0.5
  });

  it('a badly-miscalibrated set (predict 0.9, actual rate 0.1) has high Brier and high ECE', () => {
    // 10 points predicted 0.9; only 1 is positive -> empirical rate 0.1.
    const pts: CalibrationPoint[] = Array.from({ length: 10 }, (_, i) => ({ predicted: 0.9, actual: i < 1 ? 1 : 0 }));
    const rep = computeCalibration(pts);
    expect(rep.expectedCalibrationError).toBeCloseTo(0.8, 10); // |0.9 - 0.1|
    expect(rep.brier).toBeCloseTo(0.73, 10); // (0.01 + 9*0.81) / 10
    expect(rep.expectedCalibrationError!).toBeGreaterThan(0.5);
    expect(rep.brier!).toBeGreaterThan(0.5);
  });

  it('a zero-sample set returns NULLS, never a silently-substituted 0', () => {
    const rep = computeCalibration([]);
    expect(rep.n).toBe(0);
    expect(rep.brier).toBeNull();
    expect(rep.expectedCalibrationError).toBeNull();
    // The curve's x-axis is still present (10 fixed bins), but every bin is empty with NULL means.
    expect(rep.reliability).toHaveLength(10);
    for (const b of rep.reliability) {
      expect(b.n).toBe(0);
      expect(b.meanPredicted).toBeNull();
      expect(b.meanActual).toBeNull();
    }
  });

  it('reliability bins carry {binLo, binHi, n, meanPredicted, meanActual} so a curve can be drawn', () => {
    const rep = computeCalibration(perfectlyCalibrated());
    const bin2 = rep.reliability[2]!; // predicted 0.2 group
    expect(bin2.binLo).toBeCloseTo(0.2, 10);
    expect(bin2.binHi).toBeCloseTo(0.3, 10);
    expect(bin2.n).toBe(10);
    expect(bin2.meanPredicted).toBeCloseTo(0.2, 10);
    expect(bin2.meanActual).toBeCloseTo(0.2, 10);
    // An empty bin has a count of 0 and NULL means — not 0.
    const bin0 = rep.reliability[0]!;
    expect(bin0.n).toBe(0);
    expect(bin0.meanPredicted).toBeNull();
  });

  it('binning edges: predicted exactly 1.0 lands in the top bin (inclusive), and a lower-edge is right-open', () => {
    const top = computeCalibration([{ predicted: 1, actual: 1 }]);
    expect(top.reliability[9]!.n).toBe(1); // 1.0 is not dropped off the end
    expect(top.reliability[9]!.binHi).toBeCloseTo(1, 10);
    expect(top.brier).toBeCloseTo(0, 10);
    // 0.5 (exactly representable) sits on a bin's lower edge -> that bin (right-open [0.5,0.6)).
    const edge = computeCalibration([{ predicted: 0.5, actual: 0 }]);
    expect(edge.reliability[5]!.n).toBe(1);
    expect(edge.reliability[4]!.n).toBe(0);
  });

  it('refuses invalid inputs (fail loud, not clamp)', () => {
    expect(() => computeCalibration([{ predicted: 1.5, actual: 1 }])).toThrow(InvalidCalibrationError);
    expect(() => computeCalibration([{ predicted: Number.NaN, actual: 0 }])).toThrow(InvalidCalibrationError);
    expect(() => computeCalibration([{ predicted: 0.5, actual: 2 as 0 | 1 }])).toThrow(InvalidCalibrationError);
    expect(() => computeCalibration([{ predicted: 0.5, actual: 1 }], 0)).toThrow(InvalidCalibrationError);
  });
});

describe('formatCalibration — prints next to the F1 citation', () => {
  it('formats Brier and ECE to 4 dp', () => {
    const rep = computeCalibration([{ predicted: 0.9, actual: 0 }]);
    expect(formatCalibration(rep)).toMatch(/^Brier \d\.\d{4}, ECE \d\.\d{4}$/);
  });
  it('an empty-set report, and a null/undefined report, read as n/a — never a fake 0', () => {
    expect(formatCalibration(computeCalibration([]))).toBe('Brier n/a, ECE n/a');
    expect(formatCalibration(null)).toBe('Brier n/a, ECE n/a');
    expect(formatCalibration(undefined)).toBe('Brier n/a, ECE n/a');
  });
});

// --- Wiring: calibration rides the ruled measurement, gated exactly like F1 --------------------

function items(n: number): BenchmarkItem[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `halueval-${i}`,
    dataset: 'halueval' as const,
    statement: `statement ${i}`,
    goldHallucination: i % 2 === 0,
  }));
}
const WIDTH: ConfigurationWidth = {
  familiesConfigured: 2,
  familiesMin: 2,
  familiesMax: 2,
  strictness: 2,
  decisionRequiresQuorum: true,
  penaltyRequiresQuorum: true,
};
/** hal_score tracks the gold label: high on hallucinations, low on clean. Well-calibrated. */
const aligned = async (text: string): Promise<HalEvalLike> => {
  const gold = Number(text.split(' ')[1]) % 2 === 0;
  return gold ? { decision: 'vetoed', hal_score: 0.9 } : { decision: 'clean', hal_score: 0.1 };
};
/** hal_score points the WRONG way — high on clean, low on hallucinations. */
const inverted = async (text: string): Promise<HalEvalLike> => {
  const gold = Number(text.split(' ')[1]) % 2 === 0;
  return gold ? { decision: 'vetoed', hal_score: 0.1 } : { decision: 'clean', hal_score: 0.9 };
};

describe('benchmark surfaces calibration only when ruled', () => {
  it('a ruled summary carries calibration computed over the same samples as F1', async () => {
    const its = items(20);
    const ruler: MeasurementRuler = { corpus: manifestForItems('halueval-v1', its), width: WIDTH };
    const s = await scoreBenchmarkRuled(its, aligned, { ruler });
    expect(s.ruled.calibration).toBeDefined();
    expect(s.ruled.calibration!.n).toBe(20); // same N the confusion matrix scored
    expect(s.ruled.calibration!.bins).toBe(10);
    expect(typeof s.ruled.calibration!.brier).toBe('number');
    // Prints next to the F1 citation.
    const line = `${s.ruled.citation} | ${formatCalibration(s.ruled.calibration)}`;
    expect(line).toContain('F1 =');
    expect(line).toMatch(/Brier \d\.\d{4}, ECE \d\.\d{4}/);
  });

  it('an UNRULED summary carries NO calibration claim (same gate as F1)', async () => {
    const s = await scoreBenchmark(items(20), aligned); // no ruler
    expect(s.rulerStatus).toBe('UNRULED');
    expect(s.ruled).toBeUndefined(); // and therefore no calibration anywhere
  });

  it('polarity is wired right: aligned scores calibrate far better than inverted ones', async () => {
    const its = items(20);
    const ruler = (): MeasurementRuler => ({ corpus: manifestForItems('halueval-v1', its), width: WIDTH });
    const good = await scoreBenchmarkRuled(its, aligned, { ruler: ruler() });
    const bad = await scoreBenchmarkRuled(its, inverted, { ruler: ruler() });
    expect(good.ruled.calibration!.expectedCalibrationError).toBeCloseTo(0.1, 10);
    expect(bad.ruled.calibration!.expectedCalibrationError).toBeCloseTo(0.9, 10);
    expect(good.ruled.calibration!.expectedCalibrationError!).toBeLessThan(
      bad.ruled.calibration!.expectedCalibrationError!,
    );
  });
});
