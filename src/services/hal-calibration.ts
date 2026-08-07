/**
 * hal-calibration.ts — STEP 3: make HAL's confidence MEAN something.
 *
 * THE PROBLEM. HAL emits a `halScore` in [0,1] that behaves like a probability
 * and is not one. On the frozen holdout, cases scoring 0.50 turned out to be
 * hallucinations 67–100% of the time — the score is systematically UNDER-confident
 * in the middle of its range. Any downstream consumer that reads 0.5 as "a coin
 * flip" is reading a number that does not describe reality.
 *
 * That matters here more than usual, because `outcome-classification.ts`
 * MULTIPLIES by this confidence. An under-confident score silently shrinks both
 * the reward for a confident-correct answer and the penalty for a
 * confident-hallucination — which is precisely the asymmetry the harness exists
 * to enforce. A miscalibrated confidence does not just mislabel; it defuses the
 * mechanism.
 *
 * WHAT THIS IS. Post-hoc scaling of the logit — `sigmoid(scale * logit(p) + bias)`
 * — fitted by minimising negative log-likelihood on a held-out corpus. Nothing
 * else.
 *
 * WHY THERE IS A BIAS TERM, AND WHY IT IS NOT GRATUITOUS. Pure temperature
 * scaling was tried first and MEASURED first: it cut out-of-fold ECE by 2.2%,
 * which is noise. The reliability table said why. Almost all of the residual
 * error lives in one bin, [0.50,0.60), where cases are hallucinations 83–88% of
 * the time. That bin sits at logit ≈ 0 — and multiplying a logit of zero by any
 * temperature leaves it at zero. Temperature can sharpen a distribution around
 * p = 0.5; it cannot MOVE it. The error was concentrated exactly where the
 * chosen fix had no leverage.
 *
 * A bias term can shift, and measuring it confirmed the diagnosis rather than
 * merely being consistent with it: out-of-fold ECE improvement went 2.2% → 5.8%
 * at 5 folds and 0.0709 → 0.0612 at 10. Two parameters, selected on out-of-fold
 * error, not on the in-sample number that flattered temperature by 21%.
 *
 * HONEST SIZE OF THE WIN. Modest. Raw HAL was already fairly well calibrated at
 * the extremes, which is where most of the mass sits, and n = 99 cannot support
 * a strong claim. Reported as what it is.
 *
 * WHAT THIS IS EXPLICITLY NOT. It does NOT retune HAL. The signal weights, the
 * quorum, the strictness — all untouched. The transform is strictly MONOTONE, so
 * it cannot reorder any two cases; the RANKING, and therefore every verdict HAL
 * produces, is preserved exactly. Tested against the real holdout, not asserted.
 * If a "calibration" step ever reordered a case it would be a retune wearing
 * calibration's name, and every number ever quoted against this corpus would
 * have been measured on a ruler that was itself being bent.
 *
 * ONE PRECISION ABOUT THE BIAS, because it is the obvious objection. A bias
 * SHIFTS every probability, so re-thresholding a calibrated probability at a
 * fixed 0.5 would move cases across the cut even though nothing was reordered.
 * That is why verdicts keep coming from HAL's own verdict field and are never
 * recomputed by thresholding a calibrated number. Calibration answers "how sure
 * should we be", never "what is the answer".
 *
 * WHY TWO PARAMETERS AND NOT MORE. 99 holdout rows, and the informative middle
 * of the range holds about 25 of them. A piecewise or isotonic fit has enough
 * freedom to memorise that middle and would report a beautiful in-sample ECE
 * that predicts nothing — which is exactly what the in-sample figures here
 * already show at two parameters (0.0729 in-sample versus 0.0754 out-of-fold).
 * Two is what this much evidence supports. Revisit at an order of magnitude
 * more corpus, with a new ruler hash and a fresh fit.
 *
 * THE RULER TRAVELS WITH THE NUMBER (CLAUDE_RULES r24). A fitted calibrator
 * carries the corpus hash and row count it was fitted on. Applying one fitted on
 * a different corpus is a silent category error, so `assertRuler` makes it a loud
 * one instead.
 */

/**
 * A raw score of exactly 0 or 1 has an infinite logit. Clipping is unavoidable;
 * the value is a real modelling choice, not a formality — it caps how much
 * evidence one saturated case can contribute. 1e-3 bounds a single case at
 * |logit| ≈ 6.9.
 */
export const CLIP_EPS = 1e-3;

export interface CalibrationSample {
  /** Raw halScore in [0,1]: HAL's unc­alibrated P(hallucination). */
  rawScore: number;
  /** Ground truth: true when the claim really was false/hallucinated. */
  isPositive: boolean;
}

export type CalibrationMethod = 'temperature' | 'platt';

export interface FittedCalibrator {
  method: CalibrationMethod;
  /** Multiplies the logit. scale = 1/temperature. */
  scale: number;
  /** Shifts the logit. Always 0 for 'temperature'. */
  bias: number;
  /** 1/scale. T > 1 softens, T < 1 sharpens. Reported because it reads better. */
  temperature: number;
  /** Corpus this was fitted on. Applying it elsewhere is a category error. */
  ruler: string;
  corpusSha256: string;
  fittedOn: number;
  /** NLL at the optimum, for reproducibility. */
  nll: number;
}

function clip(p: number): number {
  if (!Number.isFinite(p)) return 0.5;
  return Math.min(1 - CLIP_EPS, Math.max(CLIP_EPS, p));
}

export function toLogit(p: number): number {
  const c = clip(p);
  return Math.log(c / (1 - c));
}

export function sigmoid(z: number): number {
  // Branch to avoid overflow of exp() at large |z|.
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/**
 * Apply a temperature to a raw score.
 *
 * Non-finite input returns 0.5 — maximum uncertainty — rather than propagating
 * NaN into a delta computation. A NaN confidence multiplied into a delta yields
 * a NaN delta, which the fold encoder would then reject far from the cause.
 */
export function applyTemperature(rawScore: number, temperature: number): number {
  if (!Number.isFinite(rawScore) || !Number.isFinite(temperature) || temperature <= 0) return 0.5;
  return sigmoid(toLogit(rawScore) / temperature);
}

/** Apply a fitted calibrator: sigmoid(scale * logit(p) + bias). */
export function applyCalibrator(rawScore: number, cal: Pick<FittedCalibrator, 'scale' | 'bias'>): number {
  if (!Number.isFinite(rawScore) || !Number.isFinite(cal.scale) || !Number.isFinite(cal.bias) || cal.scale <= 0) {
    return 0.5;
  }
  return sigmoid(toLogit(rawScore) * cal.scale + cal.bias);
}

/** Mean negative log-likelihood at (scale, bias). */
function nllAt(samples: readonly CalibrationSample[], scale: number, bias: number): number {
  let total = 0;
  for (const s of samples) {
    const p = sigmoid(toLogit(s.rawScore) * scale + bias);
    total += s.isPositive ? -Math.log(Math.max(p, 1e-12)) : -Math.log(Math.max(1 - p, 1e-12));
  }
  return total / Math.max(1, samples.length);
}

/**
 * Ternary search. Valid only because the objective is convex along each axis.
 *
 * Each iteration shrinks the bracket by 1/3, so 60 iterations narrow it by a
 * factor of ~1e-10 — already past double precision for these ranges. The first
 * version ran 120, which bought nothing measurable and cost a wall-clock test
 * timeout; the bracket-width stop makes the point structural rather than a
 * number someone has to remember to keep small.
 */
function ternary(f: (x: number) => number, lo: number, hi: number, iters = 60): number {
  const tol = 1e-10 * Math.max(1, Math.abs(hi - lo));
  for (let i = 0; i < iters && hi - lo > tol; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (f(m1) < f(m2)) hi = m2;
    else lo = m1;
  }
  return (lo + hi) / 2;
}

/**
 * Fit a calibrator by minimising NLL.
 *
 * The search runs over scale = 1/T rather than over T because the logistic NLL
 * is CONVEX in (scale, bias) and is NOT convex in T. Ternary search on a convex
 * objective reaches the global optimum; the same search parameterised by T could
 * settle in a local one and return a calibrator that looks fitted and is not.
 *
 * 'platt' adds the bias and is fitted by coordinate descent — each axis is a
 * one-dimensional convex problem, and the joint objective is convex, so the
 * alternation converges to the joint optimum rather than to a saddle.
 */
export function fitCalibrator(
  samples: readonly CalibrationSample[],
  opts: { ruler: string; corpusSha256: string; method?: CalibrationMethod; maxScale?: number },
): FittedCalibrator {
  const method: CalibrationMethod = opts.method ?? 'platt';
  const usable = samples.filter((s) => Number.isFinite(s.rawScore));
  if (usable.length === 0) throw new Error('cannot fit a calibrator on zero usable samples');

  // Degenerate corpora produce a runaway scale: with no counterexamples, NLL
  // falls monotonically and the optimum sits at whatever the search bound
  // happens to be. Refuse rather than return a boundary value dressed as a fit.
  const pos = usable.filter((s) => s.isPositive).length;
  if (pos === 0 || pos === usable.length) {
    throw new Error(
      `cannot fit a calibrator on a single-class corpus (${pos}/${usable.length} positive) — ` +
        'the optimum is unbounded and any parameter returned would be an artefact of the search bound',
    );
  }

  const hiScale = opts.maxScale ?? 50;
  let scale = 1;
  let bias = 0;

  if (method === 'temperature') {
    scale = ternary((a) => nllAt(usable, a, 0), 1e-3, hiScale);
  } else {
    // Coordinate descent, stopped when it stops moving. Convergence here is
    // fast — a handful of sweeps — so a fixed high iteration count is not
    // "being careful", it is 70 sweeps of recomputing the same answer.
    for (let it = 0; it < 40; it++) {
      const prevScale = scale;
      const prevBias = bias;
      scale = ternary((a) => nllAt(usable, a, bias), 1e-3, hiScale);
      bias = ternary((b) => nllAt(usable, scale, b), -15, 15);
      if (Math.abs(scale - prevScale) < 1e-9 && Math.abs(bias - prevBias) < 1e-9) break;
    }
  }

  return {
    method,
    scale,
    bias,
    temperature: 1 / scale,
    ruler: opts.ruler,
    corpusSha256: opts.corpusSha256,
    fittedOn: usable.length,
    nll: nllAt(usable, scale, bias),
  };
}

/** @deprecated Kept as the explicit temperature-only path; `fitCalibrator` is the general one. */
export function fitTemperature(
  samples: readonly CalibrationSample[],
  opts: { ruler: string; corpusSha256: string; maxBeta?: number } = { ruler: 'unknown', corpusSha256: 'unknown' },
): FittedCalibrator {
  return fitCalibrator(samples, { ...opts, method: 'temperature', maxScale: opts.maxBeta });
}

export interface EceBin {
  lo: number;
  hi: number;
  count: number;
  /** Mean predicted probability in this bin. */
  meanConfidence: number;
  /** Observed positive rate in this bin. */
  observedRate: number;
  gap: number;
}

export interface EceResult {
  ece: number;
  /** Largest single-bin gap. ECE can hide a badly wrong bin behind well-populated good ones. */
  maxGap: number;
  bins: EceBin[];
  n: number;
}

/**
 * Expected Calibration Error: mean |predicted - observed| over equal-width bins,
 * weighted by bin population.
 *
 * `maxGap` is reported alongside deliberately. ECE is an average, and an average
 * will happily hide one badly-wrong sparse bin behind several well-populated
 * good ones — reporting it alone is how a calibration claim becomes a
 * half-truth.
 */
export function expectedCalibrationError(
  predictions: readonly { p: number; isPositive: boolean }[],
  binCount = 10,
): EceResult {
  const usable = predictions.filter((x) => Number.isFinite(x.p));
  const bins: EceBin[] = [];
  let ece = 0;
  let maxGap = 0;

  for (let b = 0; b < binCount; b++) {
    const lo = b / binCount;
    const hi = (b + 1) / binCount;
    // Last bin is closed on the right so p === 1 lands somewhere.
    const inBin = usable.filter((x) => (b === binCount - 1 ? x.p >= lo && x.p <= hi : x.p >= lo && x.p < hi));
    if (inBin.length === 0) {
      bins.push({ lo, hi, count: 0, meanConfidence: 0, observedRate: 0, gap: 0 });
      continue;
    }
    const meanConfidence = inBin.reduce((a, x) => a + x.p, 0) / inBin.length;
    const observedRate = inBin.filter((x) => x.isPositive).length / inBin.length;
    const gap = Math.abs(meanConfidence - observedRate);
    ece += (inBin.length / usable.length) * gap;
    maxGap = Math.max(maxGap, gap);
    bins.push({ lo, hi, count: inBin.length, meanConfidence, observedRate, gap });
  }

  return { ece, maxGap, bins, n: usable.length };
}

/**
 * Out-of-fold ECE by k-fold cross-validation.
 *
 * An in-sample ECE after fitting on the same rows is optimistic BY CONSTRUCTION
 * — the calibrator has already seen every point it is being scored on. With one
 * parameter the optimism is small, but "small" is a claim that needs a number
 * attached, and this produces it. The out-of-fold figure is the one worth
 * quoting.
 *
 * Deterministic fold assignment (index % k), so a reviewer rerunning this gets
 * the same answer rather than a nearby one.
 */
export function crossValidatedEce(
  samples: readonly CalibrationSample[],
  k = 5,
  binCount = 10,
  method: CalibrationMethod = 'platt',
): { ece: EceResult; temperatures: number[]; biases: number[] } {
  const usable = samples.filter((s) => Number.isFinite(s.rawScore));
  const heldOut: { p: number; isPositive: boolean }[] = [];
  const temperatures: number[] = [];
  const biases: number[] = [];

  for (let fold = 0; fold < k; fold++) {
    const train = usable.filter((_, i) => i % k !== fold);
    const test = usable.filter((_, i) => i % k === fold);
    if (test.length === 0) continue;
    const posInTrain = train.filter((s) => s.isPositive).length;
    if (posInTrain === 0 || posInTrain === train.length) continue; // unfittable fold
    const cal = fitCalibrator(train, { ruler: 'cv', corpusSha256: 'cv', method });
    temperatures.push(cal.temperature);
    biases.push(cal.bias);
    for (const s of test) {
      heldOut.push({ p: applyCalibrator(s.rawScore, cal), isPositive: s.isPositive });
    }
  }

  return { ece: expectedCalibrationError(heldOut, binCount), temperatures, biases };
}

/**
 * Refuse to apply a calibrator fitted on a different corpus.
 *
 * A temperature is only meaningful against the distribution it was fitted on.
 * Silently applying yesterday's constant to a new corpus is exactly the
 * comparing-numbers-across-rulers failure r24 exists to stop, and it fails
 * invisibly — the output is still a plausible number in [0,1].
 */
export function assertRuler(cal: FittedCalibrator, corpusSha256: string): void {
  if (cal.corpusSha256 !== corpusSha256) {
    throw new Error(
      `calibrator ruler mismatch: fitted on ${cal.corpusSha256.slice(0, 12)}, ` +
        `applied to ${corpusSha256.slice(0, 12)} — refit rather than reuse`,
    );
  }
}

/**
 * Turn a calibrated P(hallucination) into the confidence that feeds
 * `OutcomeRecord.halCalibratedConfidence`.
 *
 * THE DIRECTION MATTERS AND IS EASY TO GET BACKWARDS. Downstream, confidence
 * MULTIPLIES: it scales the reward for a success and amplifies the penalty for
 * an agent-fault failure. So the right quantity in both cases is HAL's
 * confidence in the verdict that produced the classification:
 *
 *   vetoed  → confidence = calibrated P(hallucination)
 *   clean   → confidence = 1 - calibrated P(hallucination)
 *
 * The payoff falls out of the arithmetic: when HAL is genuinely torn (p ≈ 0.5),
 * BOTH the reward and the penalty shrink toward nothing. An uncertain verdict
 * should move reputation less, and here that is a consequence of the definition
 * rather than a special case someone remembered to write.
 */
export function verdictConfidence(calibratedPFalse: number, verdict: 'vetoed' | 'flagged' | 'clean'): number {
  if (!Number.isFinite(calibratedPFalse)) return 0.5;
  const p = Math.min(1, Math.max(0, calibratedPFalse));
  return verdict === 'clean' ? 1 - p : p;
}

export interface CalibratedConfidence {
  /** HAL's untouched output, carried for audit. */
  raw: number;
  /** Calibrated P(hallucination). */
  calibratedPFalse: number;
  /** What feeds OutcomeRecord — direction depends on the verdict. */
  confidence: number;
  temperature: number;
  ruler: string;
}

/** The one call a consumer needs. Raw is never discarded — only demoted from load-bearing. */
export function calibrate(
  rawScore: number,
  verdict: 'vetoed' | 'flagged' | 'clean',
  cal: FittedCalibrator,
): CalibratedConfidence {
  const calibratedPFalse = applyCalibrator(rawScore, cal);
  return {
    raw: rawScore,
    calibratedPFalse,
    confidence: verdictConfidence(calibratedPFalse, verdict),
    temperature: cal.temperature,
    ruler: cal.ruler,
  };
}
