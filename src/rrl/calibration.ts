/**
 * RRL — Per-provider confidence CALIBRATION layer (WS2.3 calibration-correction).
 * ------------------------------------------------------------------------------------
 * WHY THIS EXISTS
 *   The WS2.3 shadow RRL passed its honesty gates on SYNTHETIC agents, but on REAL labeled
 *   HAL outcomes (reports/2026-07-18/hal-outcomes.jsonl) Gate-1 (calibration / ECE) FAILED:
 *   real LLM providers do not report honest probabilities. Their spread is heterogeneous —
 *   some are wildly over-confident (gemini: says ~0.99, right ~0.79), some slightly
 *   under-confident (deepseek), some near-calibrated (grok). Aggregate raw ECE ≈ 0.14 ≫ 0.05.
 *
 * WHAT THIS DOES (design: reports/2026-07-18/RRL_CALIBRATION_DESIGN.md — HYBRID A + B, C staged)
 *   1. Fit a per-provider RELIABILITY CURVE from that provider's own (confidence, correct)
 *      pairs — a binned, shrinkage-regularised, MONOTONE (isotonic/PAV) map raw→calibrated.
 *      This recalibrates the *signal* RRL trusts (Option A). Gate-1 is then measured on the
 *      recalibrated signal (its purpose is to certify the probability RRL acts on — NOT to
 *      certify the LLM vendors, which RRL cannot fix and must not be blocked on forever).
 *   2. Preserve the calibration INCENTIVE with a RELATIVE credential (Option B): reward the
 *      provider that is better-calibrated than its peers. Because providers differ a lot,
 *      this gradient is real and is NOT erased by (1) — (1) de-biases the trusted signal,
 *      (2) rewards the honest reporter, and they operate on different quantities.
 *   3. selfBaselineCredential (Option C) is included for the antifragile end-state (reward
 *      improving on your OWN past calibration) but needs a temporal baseline the single-shot
 *      corpus does not yet have — see design doc §data-sufficiency.
 *
 * DISCIPLINE
 *   - Pure + deterministic. NO I/O, NO DB, NO network, NO clock, NO RNG (K-fold uses index
 *     residues, not random shuffles → reproducible). Unit-tested (tests/rrl-calibration.test.ts).
 *   - Nothing here reads/writes RepID, ERC-8004, or ZKP. It computes calibration maps + factors.
 *   - `src/hal/lib/*` is untouched by this work (branch feat/rrl-calibration).
 */

// ============================================================================
// Types
// ============================================================================

/** A single ground-truthed provider answer: stated confidence + realised correctness. */
export interface ConfCorrectPair {
  confidence: number; // stated p in [0,1]
  correct: 0 | 1; // 1 if the verdict matched ground truth
}

export interface CalibrationConfig {
  /** Reliability-diagram resolution. Default 10 (matches the shadow-replay ECE bins). */
  nBins: number;
  /** Pseudo-count pulling each bin's empirical accuracy toward the provider prior. Higher =
   *  more shrinkage = more conservative on thin bins. Default 10. */
  shrinkageK: number;
  /** Below this TOTAL sample count the curve is the identity map (no correction) — we do not
   *  trust a fit we cannot support. Default 30. */
  minSamples: number;
}

export function defaultCalibrationConfig(): CalibrationConfig {
  return { nBins: 10, shrinkageK: 10, minSamples: 30 };
}

/** A fitted per-provider reliability curve: a monotone raw→calibrated confidence map. */
export interface ReliabilityCurve {
  provider: string;
  n: number; // training sample count
  identity: boolean; // true => insufficient data, applyCalibration returns rawConf unchanged
  prior: number; // provider global accuracy = the shrinkage target
  calibrated: number[]; // length nBins, MONOTONE non-decreasing calibrated prob per raw-conf bin
  binMeanConf: number[]; // reporting: mean raw confidence per bin (NaN-safe: prior-fallback)
  binAcc: number[]; // reporting: raw empirical accuracy per bin
  binN: number[]; // reporting: sample count per bin
  eceRaw: number; // ECE of the raw (uncorrected) pairs — the provider-honesty diagnostic
}

// ============================================================================
// Core helpers
// ============================================================================

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Confidence -> bin index in [0, nBins-1]. Right-open bins except the last (1.0 -> last). */
export function binIndex(conf: number, nBins: number): number {
  const i = Math.floor(clamp01(conf) * nBins);
  return i < 0 ? 0 : i >= nBins ? nBins - 1 : i;
}

/**
 * Expected Calibration Error — weighted mean |mean-conf − realised-accuracy| over nBins.
 * IDENTICAL definition to the shadow-replay harness so the numbers are directly comparable.
 * Empty stream returns 1 (maximally uncalibrated) to fail loud, matching the harness.
 */
export function expectedCalibrationError(pairs: ConfCorrectPair[], nBins = 10): number {
  const total = pairs.length;
  if (total === 0) return 1;
  const cs = new Array(nBins).fill(0) as number[];
  const cor = new Array(nBins).fill(0) as number[];
  const n = new Array(nBins).fill(0) as number[];
  for (const p of pairs) {
    const i = binIndex(p.confidence, nBins);
    cs[i]! += p.confidence;
    cor[i]! += p.correct;
    n[i]! += 1;
  }
  let ece = 0;
  for (let i = 0; i < nBins; i++) {
    if (n[i]! === 0) continue;
    ece += (n[i]! / total) * Math.abs(cs[i]! / n[i]! - cor[i]! / n[i]!);
  }
  return ece;
}

/**
 * Weighted Pool-Adjacent-Violators (isotonic regression). Given per-bin values and weights,
 * return a NON-DECREASING sequence of the same length that is the weighted-least-squares
 * monotone fit. Guarantees applyCalibration is monotone in raw confidence (a higher stated
 * confidence can never map to a lower calibrated probability — a required sanity property).
 */
export function poolAdjacentViolators(values: number[], weights: number[]): number[] {
  const m = values.length;
  if (m === 0) return [];
  // Each block tracks its weighted mean, total weight, and how many original bins it spans.
  const blocks: { mean: number; weight: number; count: number }[] = [];
  for (let i = 0; i < m; i++) {
    let cur = { mean: values[i]!, weight: Math.max(weights[i]!, 1e-9), count: 1 };
    while (blocks.length > 0 && blocks[blocks.length - 1]!.mean > cur.mean) {
      const prev = blocks.pop()!;
      const w = prev.weight + cur.weight;
      cur = { mean: (prev.mean * prev.weight + cur.mean * cur.weight) / w, weight: w, count: prev.count + cur.count };
    }
    blocks.push(cur);
  }
  const out: number[] = [];
  for (const b of blocks) for (let c = 0; c < b.count; c++) out.push(b.mean);
  return out;
}

// ============================================================================
// Fit + apply
// ============================================================================

/**
 * Fit a per-provider reliability curve from its own (confidence, correct) pairs.
 *
 * Algorithm (binned histogram calibration + shrinkage + isotonic monotonisation):
 *   - prior = provider global accuracy (the shrinkage target / small-sample fallback).
 *   - For each confidence bin, calibrated = (correct + K·prior) / (n_bin + K). This is a
 *     Beta(K·prior, K·(1−prior)) posterior mean — a thin bin is pulled toward the prior,
 *     a well-populated bin keeps its empirical accuracy. Empty bins take the prior.
 *   - PAV makes the per-bin calibrated values monotone non-decreasing in raw confidence.
 *   - If total n < minSamples the whole curve is the IDENTITY (we refuse to fit on a sample
 *     we cannot support — the caller then scores on raw confidence, unchanged).
 */
export function fitReliabilityCurve(
  provider: string,
  pairs: ConfCorrectPair[],
  cfg: CalibrationConfig = defaultCalibrationConfig(),
): ReliabilityCurve {
  const nBins = cfg.nBins;
  const n = pairs.length;
  const prior = n > 0 ? pairs.reduce((s, p) => s + p.correct, 0) / n : 0.5;

  const cs = new Array(nBins).fill(0) as number[];
  const cor = new Array(nBins).fill(0) as number[];
  const cnt = new Array(nBins).fill(0) as number[];
  for (const p of pairs) {
    const i = binIndex(p.confidence, nBins);
    cs[i]! += p.confidence;
    cor[i]! += p.correct;
    cnt[i]! += 1;
  }
  const binMeanConf = cs.map((s, i) => (cnt[i]! > 0 ? s / cnt[i]! : (i + 0.5) / nBins));
  const binAcc = cor.map((c, i) => (cnt[i]! > 0 ? c / cnt[i]! : prior));
  const eceRaw = expectedCalibrationError(pairs, nBins);

  if (n < cfg.minSamples) {
    // Not enough data to fit a trustworthy curve → identity map (shrink fully to the prior:
    // "no correction"). The caller scores on raw confidence.
    return {
      provider,
      n,
      identity: true,
      prior,
      calibrated: Array.from({ length: nBins }, (_, i) => (i + 0.5) / nBins), // identity-ish per-bin center
      binMeanConf,
      binAcc,
      binN: cnt.slice(),
      eceRaw,
    };
  }

  // Shrinkage-regularised per-bin calibrated accuracy (Beta posterior mean toward prior):
  // calibrated = (correct_in_bin + K·prior) / (n_in_bin + K). Thin bins shrink to the prior.
  const shrunk = cnt.map((c, i) => (cor[i]! + cfg.shrinkageK * prior) / (c + cfg.shrinkageK));
  // Weight each bin by its own count (empty bins get nominal weight 1 so PAV can order them).
  const weights = cnt.map((c) => c || 1);
  const calibrated = poolAdjacentViolators(shrunk, weights).map(clamp01);

  return { provider, n, identity: false, prior, calibrated, binMeanConf, binAcc, binN: cnt.slice(), eceRaw };
}

/** Map a raw confidence to its calibrated probability via the fitted curve's bin. */
export function applyCalibration(curve: ReliabilityCurve, rawConf: number): number {
  if (curve.identity) return rawConf;
  const i = binIndex(rawConf, curve.calibrated.length);
  return curve.calibrated[i]!;
}

/** Convenience: a pure closure `(conf)=>calibratedConf` for the RRLScorer calibration hook. */
export function makeCalibrator(curve: ReliabilityCurve): (conf: number) => number {
  return (conf: number) => applyCalibration(curve, conf);
}

// ============================================================================
// Out-of-sample evaluation — the HONEST Gate-1 number
// ============================================================================

/**
 * K-fold OUT-OF-SAMPLE ECE for one provider: fit the curve on K−1 folds, apply to the held-out
 * fold, aggregate the recalibrated (conf,correct) pairs across folds, return their ECE.
 *
 * This is the number that may be REPORTED as the calibration result. In-sample ECE (fit and
 * measure on the same data) is circular — isotonic/binned calibration drives it toward ~0 by
 * construction — so it must never be the headline. Folds are deterministic (index % k), so the
 * function is pure and reproducible with no RNG.
 */
export function kFoldEce(
  pairs: ConfCorrectPair[],
  k = 5,
  cfg: CalibrationConfig = defaultCalibrationConfig(),
): number {
  if (pairs.length < k || k < 2) {
    // Too few points to hold any out — fall back to raw ECE (and the caller should flag n).
    return expectedCalibrationError(pairs, cfg.nBins);
  }
  const recal: ConfCorrectPair[] = [];
  for (let f = 0; f < k; f++) {
    const train = pairs.filter((_, i) => i % k !== f);
    const test = pairs.filter((_, i) => i % k === f);
    const curve = fitReliabilityCurve('kfold', train, cfg);
    for (const p of test) recal.push({ confidence: clamp01(applyCalibration(curve, p.confidence)), correct: p.correct });
  }
  return expectedCalibrationError(recal, cfg.nBins);
}

// ============================================================================
// Incentive-preserving credentials (keep "reward calibration" alive after recalibration)
// ============================================================================

export interface CredentialOpts {
  /** Floor for the returned multiplier so a bad-but-honest provider is shaved, not zeroed. */
  floor: number;
  /** Sensitivity: how hard the multiplier reacts to an ECE gap. */
  slope: number;
}
export function defaultCredentialOpts(): CredentialOpts {
  return { floor: 0.4, slope: 6 };
}

/**
 * Option B — RELATIVE calibration credential. Rewards a provider for being better-calibrated
 * than its PEERS (since absolute calibration is unwinnable on real overconfident LLMs, grade
 * on a curve). Returns a multiplier in [floor, 1]: at/above the peer-median ECE → shaved toward
 * floor; below (better than) the median → toward 1. Preserves the calibration gradient that a
 * pure recalibration (Option A) would otherwise flatten.
 *
 * `providerEce` and `peerEces` are RAW per-provider ECEs (the honesty signal — computed on
 * self-reported confidence, NOT recalibrated, so honest reporting is what's rewarded).
 */
export function relativeCalibrationCredential(
  providerEce: number,
  peerEces: number[],
  opts: CredentialOpts = defaultCredentialOpts(),
): number {
  if (peerEces.length === 0) return 1;
  const sorted = [...peerEces].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  // gap > 0 means WORSE than median (higher ECE) → shave. gap < 0 means better → toward 1.
  const gap = providerEce - median;
  return clampRange(1 - opts.slope * gap, opts.floor, 1);
}

/**
 * Option C — SELF-BASELINE calibration credential (antifragile / recovery-path). Rewards a
 * provider for IMPROVING on its own historical calibration (currentEce < baselineEce → toward
 * 1; regressed → toward floor). Needs a temporal baseline; on single-shot data there is no
 * baseline yet, so callers pass baselineEce = currentEce → returns 1 (neutral). Documented as
 * the Stage-1.5 target once per-provider calibration history accrues.
 */
export function selfBaselineCredential(
  currentEce: number,
  baselineEce: number,
  opts: CredentialOpts = defaultCredentialOpts(),
): number {
  const improvement = baselineEce - currentEce; // >0 = got better
  return clampRange(1 + opts.slope * improvement, opts.floor, 1.25);
}

function clampRange(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
