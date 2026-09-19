/**
 * Item 13 (hierarchical durable memory) — heat-eviction sweep orchestrator.
 *
 * Pure function: all I/O is injected; this module classifies leaves and returns
 * a report — it does NOT write to the database, evict rows, or touch the root.
 * The caller (when it exists) decides what to do with eviction/reactivation candidates.
 *
 * Shadow-first: no real eviction until Sean GO. Intended integration path is a
 * cron that passes fetched `agent_memory_leaves` rows, logs the report under
 * HEAT_EVICTION_SHADOW_ENABLED, and does nothing else until the enforce flag is set.
 */

import {
  computeHeatScore,
  classifyHeatTier,
  type HeatLeaf,
  type HeatTier,
} from './memory-heat';

export interface ClassifiedLeaf extends HeatLeaf {
  heat: number;
  tier: HeatTier;
}

export interface HeatEvictionReport {
  hot: ClassifiedLeaf[];
  warm: ClassifiedLeaf[];
  cold: ClassifiedLeaf[];
  onChain: ClassifiedLeaf[];
  /**
   * Cold leaves selected for eviction: heat ≤ evictionMaxHeat, sorted ascending
   * (coldest first), capped at evictionLimit.
   */
  evictionCandidates: ClassifiedLeaf[];
  /**
   * Cold leaves that have warmed past reactivationMinHeat and should be promoted
   * rather than evicted. Sorted descending (warmest first).
   * A leaf can appear in both evictionCandidates and reactivationCandidates —
   * the caller resolves the conflict (reactivation wins in the intended integration).
   */
  reactivationCandidates: ClassifiedLeaf[];
  stats: {
    total: number;
    hotCount: number;
    warmCount: number;
    coldCount: number;
    onChainCount: number;
  };
}

export interface HeatSweepOptions {
  /** Max eviction candidates returned (default 10). */
  evictionLimit?: number;
  /** Max heat eligible for eviction — default matches cold threshold (< 0.3). */
  evictionMaxHeat?: number;
  /**
   * Min heat for a cold leaf to be a reactivation candidate.
   * Default 0.25 — top ~17% of the cold band (0–0.3) that is warming toward warm.
   */
  reactivationMinHeat?: number;
  nowMs?: number;
}

/**
 * Classify a set of leaves by heat tier and return an eviction/reactivation report.
 * Does not mutate the input array.
 */
export function runHeatEvictionSweep(
  leaves: HeatLeaf[],
  opts: HeatSweepOptions = {},
): HeatEvictionReport {
  const {
    evictionLimit = 10,
    evictionMaxHeat = 0.3,
    reactivationMinHeat = 0.25,
    nowMs = Date.now(),
  } = opts;

  const classified: ClassifiedLeaf[] = leaves.map((leaf) => {
    const heat = computeHeatScore(leaf.lastAccessedMs, leaf.accessCount, nowMs);
    const tier = classifyHeatTier(heat, leaf.isAnchored);
    return { ...leaf, heat, tier };
  });

  const hot = classified.filter((l) => l.tier === 'hot');
  const warm = classified.filter((l) => l.tier === 'warm');
  const cold = classified.filter((l) => l.tier === 'cold');
  const onChain = classified.filter((l) => l.tier === 'on_chain');

  const evictionCandidates = cold
    .filter((l) => l.heat <= evictionMaxHeat)
    .sort((a, b) => a.heat - b.heat)
    .slice(0, evictionLimit);

  const reactivationCandidates = cold
    .filter((l) => l.heat >= reactivationMinHeat)
    .sort((a, b) => b.heat - a.heat);

  return {
    hot,
    warm,
    cold,
    onChain,
    evictionCandidates,
    reactivationCandidates,
    stats: {
      total: classified.length,
      hotCount: hot.length,
      warmCount: warm.length,
      coldCount: cold.length,
      onChainCount: onChain.length,
    },
  };
}
