/**
 * ANFIS-Ikigai — Anticipatory metrics (v0)
 *
 * Reads the recent score history of a single signal and reports whether the
 * composite is rising, falling, or stable. This is the "anticipatory" side
 * of "ANFIS with anticipatory metrics" — patent-relevant because it
 * differentiates from recommenders that only look at the current score.
 *
 * v0 keeps the math deliberately simple: arithmetic mean of the last N
 * prior scores, compared to the current score. v1 candidates include
 * exponential weighting, slope estimation, or a trend-detection ANFIS sub-
 * network — none of which are needed yet.
 *
 * Determinism: depends on the DB query result ordering, which we pin via
 * `.order('scored_at', { ascending: false })` and an explicit limit. Two
 * calls with the same DB state return the same delta.
 */

import { db } from '../db';

export type Trend = 'rising' | 'stable' | 'falling';

export interface AnticipatoryResult {
  delta: number;
  trend: Trend;
  lookback_count: number;
  /** Mean of the prior scores (excluding the current). NaN-safe: 0 when no priors. */
  prior_mean: number;
}

/** Number of prior score events to average over. */
export const V0_LOOKBACK_N = 10;

/** Minimum prior count required before we report any non-zero delta. */
export const V0_MIN_PRIORS = 3;

/** Threshold for declaring a non-stable trend, in composite-score units. */
export const V0_TREND_BAND = 0.05;

/**
 * Compute the anticipatory delta for a signal.
 *
 * If fewer than V0_MIN_PRIORS prior scores exist, returns delta=0 with
 * trend='stable'. The lookback_count in that case is the actual number of
 * priors found, which is informative even when we can't yet form a trend.
 */
export async function computeAnticipatoryDelta(
  signalId: string,
  currentCompositeScore: number,
): Promise<AnticipatoryResult> {
  const { data, error } = await db
    .from('anfis_score_events')
    .select('composite_score, scored_at')
    .eq('signal_id', signalId)
    .order('scored_at', { ascending: false })
    .limit(V0_LOOKBACK_N);

  if (error) {
    // Database failure is not fatal to scoring — log and return a neutral
    // anticipatory record. The score event will still get persisted, just
    // without a meaningful delta.
    console.warn('[anfis-anticipatory] lookup failed:', error.message);
    return { delta: 0, trend: 'stable', lookback_count: 0, prior_mean: 0 };
  }

  const priors = (data ?? []).map(r => Number(r.composite_score));
  if (priors.length < V0_MIN_PRIORS) {
    return { delta: 0, trend: 'stable', lookback_count: priors.length, prior_mean: 0 };
  }

  const sum = priors.reduce((acc, x) => acc + x, 0);
  const priorMean = sum / priors.length;
  const delta = currentCompositeScore - priorMean;

  let trend: Trend = 'stable';
  if (delta > V0_TREND_BAND) trend = 'rising';
  else if (delta < -V0_TREND_BAND) trend = 'falling';

  return {
    delta,
    trend,
    lookback_count: priors.length,
    prior_mean: priorMean,
  };
}

/**
 * Pure variant — used by tests so they don't have to mock Supabase. Same
 * math, takes the priors as an input array.
 */
export function computeAnticipatoryDeltaPure(
  priors: number[],
  currentCompositeScore: number,
): AnticipatoryResult {
  if (priors.length < V0_MIN_PRIORS) {
    return { delta: 0, trend: 'stable', lookback_count: priors.length, prior_mean: 0 };
  }

  const sum = priors.reduce((acc, x) => acc + x, 0);
  const priorMean = sum / priors.length;
  const delta = currentCompositeScore - priorMean;

  let trend: Trend = 'stable';
  if (delta > V0_TREND_BAND) trend = 'rising';
  else if (delta < -V0_TREND_BAND) trend = 'falling';

  return {
    delta,
    trend,
    lookback_count: priors.length,
    prior_mean: priorMean,
  };
}
