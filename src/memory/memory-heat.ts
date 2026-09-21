/**
 * Item 13 (hierarchical durable memory) — heat-score primitive.
 *
 * WHY φ-weighted: the ecosystem uses φ (golden ratio) throughout ANFIS and scoring. Recency
 * dominates (weight φ−1 ≈ 0.618) because a leaf accessed yesterday matters more than one
 * accessed 100 times a year ago; frequency fills the remaining weight (2−φ ≈ 0.382).
 *
 * WHY 30-day half-life: mirrors RepID's activity_30d window — a leaf's heat decays on the
 * same timescale as the agent's own reputation signal.
 *
 * This module is pure: no I/O, no Supabase. The orchestrator (item 13 sweep, next beat)
 * injects fetched rows and receives decisions back.
 */

const PHI = 1.61803398875;
/** Recency weight: φ − 1 ≈ 0.618 */
const RECENCY_WEIGHT = PHI - 1;
/** Frequency weight: 2 − φ ≈ 0.382 */
const FREQUENCY_WEIGHT = 2 - PHI;
/** 30-day half-life in ms — matches RepID activity_30d */
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
/** Access count at which frequency saturates to 1.0 */
const FREQUENCY_SATURATION = 50;

export type HeatTier = 'hot' | 'warm' | 'cold' | 'on_chain';

export interface HeatLeaf {
  id: string;
  /** Unix ms of last access; 0 means never accessed */
  lastAccessedMs: number;
  accessCount: number;
  /** Whether this leaf has already been anchored on-chain via EAS */
  isAnchored: boolean;
}

/**
 * Compute a normalized heat score [0, 1].
 *
 * heat = RECENCY_WEIGHT * recency + FREQUENCY_WEIGHT * frequency
 *
 * recency = 2^(−age / HALF_LIFE_MS)  — 1.0 if just accessed, 0.5 at 30 days, → 0 asymptotically
 * frequency = min(accessCount / FREQUENCY_SATURATION, 1)
 */
export function computeHeatScore(
  lastAccessedMs: number,
  accessCount: number,
  nowMs: number = Date.now(),
): number {
  // 0 is the sentinel for "never accessed" — treat as maximum age (recency = 0).
  const recency = lastAccessedMs === 0 ? 0 : Math.pow(2, -(nowMs - lastAccessedMs) / HALF_LIFE_MS);
  const frequency = Math.min(accessCount / FREQUENCY_SATURATION, 1);
  return RECENCY_WEIGHT * recency + FREQUENCY_WEIGHT * frequency;
}

/**
 * Classify a heat score into a tier.
 * On-chain leaves keep their tier regardless of heat — they are immutable and already durable.
 */
export function classifyHeatTier(heat: number, isAnchored = false): HeatTier {
  if (isAnchored) return 'on_chain';
  if (heat > 0.6) return 'hot';
  if (heat >= 0.3) return 'warm';
  return 'cold';
}

/**
 * Select eviction candidates: leaves with heat ≤ maxHeat, sorted ascending (coldest first),
 * up to `limit`. Does not mutate input.
 */
export function selectEvictionCandidates(
  leaves: HeatLeaf[],
  maxHeat: number,
  limit: number,
  nowMs: number = Date.now(),
): Array<HeatLeaf & { heat: number }> {
  return leaves
    .map((leaf) => ({ ...leaf, heat: computeHeatScore(leaf.lastAccessedMs, leaf.accessCount, nowMs) }))
    .filter((leaf) => !leaf.isAnchored && leaf.heat <= maxHeat)
    .sort((a, b) => a.heat - b.heat)
    .slice(0, limit);
}

/**
 * Select reactivation candidates: cold leaves with heat ≥ minHeat that have warmed up,
 * sorted descending (warmest first). Does not mutate input.
 */
export function selectReactivationCandidates(
  leaves: HeatLeaf[],
  minHeat: number,
  nowMs: number = Date.now(),
): Array<HeatLeaf & { heat: number }> {
  return leaves
    .map((leaf) => ({ ...leaf, heat: computeHeatScore(leaf.lastAccessedMs, leaf.accessCount, nowMs) }))
    .filter((leaf) => !leaf.isAnchored && leaf.heat >= minHeat)
    .sort((a, b) => b.heat - a.heat);
}
