/**
 * HAL CALIBRATION — does hal_score mean what it says?
 * OUTPUT_PATH: src/hal/calibration.ts
 *
 * The measurement ruler (./measurement-ruler, ./corpus-manifest) already makes an F1 carry the
 * population and configuration it was taken at. F1 answers "how often is the veto right?" It does NOT
 * answer "when HAL says 0.9, does the thing happen 90% of the time?" — that is CALIBRATION, and a
 * detector can have a fine F1 while its score is a meaningless dial. r24 and the TrustMesh Technical
 * paper §7.5 ask measurement integrity to carry a Brier score and reliability curves for exactly this.
 *
 * This module is the pure math for that: given per-case (predicted probability of the positive class,
 * realised 0/1 outcome) pairs it returns the Brier score, a fixed-bin reliability breakdown a curve can
 * be drawn from, and the Expected Calibration Error. ./measurement-ruler attaches the result to a
 * RuledMeasurement, so a calibration number is reported WITH the ruler it was taken at — because a
 * Brier/ECE is only comparable within one ruler, exactly as F1 is. Two Briers on two corpora are not a
 * trend.
 *
 * POLARITY (stated once, because it is silently easy to flip): the positive class is HALLUCINATION.
 * `predicted` is HAL's probability that the case is a hallucination (hal_score); `actual` is 1 when the
 * gold label says hallucination and 0 otherwise — the SAME positive class the confusion matrix and F1
 * use. A report built with the polarity flipped would reward exactly the cases it should punish.
 *
 * NULLS, NOT ZEROS: an empty set has no Brier and no ECE, so they are `null`, never 0 — a silent 0
 * reads as "perfectly calibrated", the same bug ./measurement-ruler's `metricsFromMatrix` refuses when
 * it returns null for 0/0. An empty bin's means are null for the same reason.
 *
 * BINNING: right-open bins of equal width via `Math.floor(predicted * bins)`, the top bin inclusive of
 * predicted === 1 — the same convention as src/rrl/calibration.ts's `binIndex` (kept local, not
 * imported, so the measurement side carries no dependency on the provider-recalibration subsystem).
 * Exact-decimal lower edges follow IEEE754 (0.5 lands in [0.5,0.6); 0.3*10 is 2.9999… so 0.3 lands in
 * [0.2,0.3)); a boundary point in an adjacent bin shifts ECE by O(1/N) and never changes a decision.
 *
 * NOT TO BE CONFUSED WITH its two cousins, which TRANSFORM scores: src/rrl/calibration.ts FITS a
 * per-provider recalibration curve (its ECE returns 1 on empty, to fail a gate loud), and
 * src/services/hal-calibration.ts recalibrates verdict confidence. This module ONLY MEASURES — it never
 * transforms a score, moves a threshold, or changes a decision or a veto.
 *
 * PURITY: no I/O, no env, no DB. Reproducible from the pairs alone.
 */

/** Default reliability-curve width: 10 bins of 0.1. */
export const DEFAULT_CALIBRATION_BINS = 10;

/** One (predicted probability of the positive class, realised outcome) pair. */
export interface CalibrationPoint {
  /** HAL's predicted probability the case is a HALLUCINATION (hal_score). Must be finite in [0,1]. */
  predicted: number;
  /** Realised outcome: 1 = positive class (gold hallucination) occurred, 0 = did not. */
  actual: 0 | 1;
}

/** One reliability-curve bin: a slice of predicted-probability space and what actually happened in it. */
export interface ReliabilityBin {
  /** Inclusive lower edge of the predicted-probability bin. */
  binLo: number;
  /** Upper edge. Exclusive, except the top bin, which includes predicted === 1. */
  binHi: number;
  /** How many points fell in this bin. */
  n: number;
  /** Mean predicted probability of the points in the bin; null when the bin is empty. */
  meanPredicted: number | null;
  /** Empirical positive rate (mean actual) of the points in the bin; null when the bin is empty. */
  meanActual: number | null;
}

/** Calibration of a predicted score over one population — the companion of a confusion matrix's F1. */
export interface CalibrationReport {
  /** Points scored. */
  n: number;
  /** Number of reliability bins (the width of the curve). */
  bins: number;
  /** Mean squared error between predicted and actual = mean((p-a)^2); null for an empty set. */
  brier: number | null;
  /** Expected Calibration Error = sum_b (n_b/N)·|meanPredicted_b − meanActual_b|; null for empty. */
  expectedCalibrationError: number | null;
  /** The fixed bins, always present (length === bins), so a reliability curve has a stable x-axis. */
  reliability: ReliabilityBin[];
}

/** Thrown when the pairs cannot be turned into an honest calibration number. */
export class InvalidCalibrationError extends Error {
  constructor(message: string) {
    super(`[hal-calibration] ${message}`);
    this.name = 'InvalidCalibrationError';
  }
}

/** predicted → bin index in [0, bins-1]. Right-open; the top bin includes predicted === 1. */
function binIndexOf(predicted: number, bins: number): number {
  const i = Math.floor(predicted * bins);
  return i >= bins ? bins - 1 : i < 0 ? 0 : i;
}

/**
 * Brier score, reliability breakdown and ECE over the pairs. Pure; reproducible from the pairs alone.
 *
 * Refuses an out-of-range `predicted`, a non-binary `actual`, or a non-positive `bins` — a garbage input
 * fails loud here rather than silently biasing a number that then looks authoritative. An empty set is
 * NOT an error: it yields a report whose Brier and ECE are `null` and whose bins are all empty.
 */
export function computeCalibration(
  points: readonly CalibrationPoint[],
  bins: number = DEFAULT_CALIBRATION_BINS,
): CalibrationReport {
  if (!Number.isInteger(bins) || bins <= 0) {
    throw new InvalidCalibrationError(`bins must be a positive integer (got ${JSON.stringify(bins)})`);
  }

  const sumPred = new Array<number>(bins).fill(0);
  const sumActual = new Array<number>(bins).fill(0);
  const count = new Array<number>(bins).fill(0);

  let brierSum = 0;
  for (let k = 0; k < points.length; k++) {
    const { predicted: p, actual: a } = points[k]!;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new InvalidCalibrationError(
        `point ${k}: predicted must be a finite number in [0,1] (got ${JSON.stringify(p)})`,
      );
    }
    if (a !== 0 && a !== 1) {
      throw new InvalidCalibrationError(`point ${k}: actual must be 0 or 1 (got ${JSON.stringify(a)})`);
    }
    brierSum += (p - a) * (p - a);
    const i = binIndexOf(p, bins);
    sumPred[i]! += p;
    sumActual[i]! += a;
    count[i]! += 1;
  }

  const N = points.length;
  const binWidth = 1 / bins;
  const reliability: ReliabilityBin[] = [];
  let ece = 0;
  for (let i = 0; i < bins; i++) {
    const n = count[i]!;
    const meanPredicted = n === 0 ? null : sumPred[i]! / n;
    const meanActual = n === 0 ? null : sumActual[i]! / n;
    if (n > 0) ece += (n / N) * Math.abs((meanPredicted as number) - (meanActual as number));
    reliability.push({
      binLo: i * binWidth,
      binHi: (i + 1) * binWidth,
      n,
      meanPredicted,
      meanActual,
    });
  }

  return {
    n: N,
    bins,
    brier: N === 0 ? null : brierSum / N,
    expectedCalibrationError: N === 0 ? null : ece,
    reliability,
  };
}

/** `Brier 0.0123, ECE 0.0456` — the calibration half of a citation, printed next to the F1 line. */
export function formatCalibration(report: CalibrationReport | null | undefined): string {
  const fmt = (x: number | null | undefined): string =>
    x === null || x === undefined || Number.isNaN(x) ? 'n/a' : x.toFixed(4);
  if (!report) return 'Brier n/a, ECE n/a';
  return `Brier ${fmt(report.brier)}, ECE ${fmt(report.expectedCalibrationError)}`;
}
