/**
 * Item 13 (hierarchical durable memory) — shadow-log caller for heat-eviction sweep.
 *
 * Reads HEAT_EVICTION_SHADOW_ENABLED (default off). When enabled, calls
 * runHeatEvictionSweepForAgent for the given agent and logs a one-line JSON
 * summary to console.log so Railway surfaces it in the service logs without
 * any prod data being mutated. Never throws — all errors are console.warn'd.
 *
 * Wire into score-monitor's per-agent loop as a fire-and-forget call.
 * Flip HEAT_EVICTION_SHADOW_ENABLED=true in Railway when shadow logs are wanted;
 * the function is otherwise completely inert.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runHeatEvictionSweepForAgent } from './memory-heat-db-sweep';
import type { HeatSweepOptions } from './memory-heat-sweep';
import { writeHeatTiers } from './memory-heat-tier-writer';
import type { HeatTier } from './memory-heat';

/** Injected for testability — real default is runHeatEvictionSweepForAgent. */
export type SweepFn = typeof runHeatEvictionSweepForAgent;

export async function logHeatSweepShadow(
  supabase: SupabaseClient,
  agentId: string,
  opts?: HeatSweepOptions,
  sweepFn: SweepFn = runHeatEvictionSweepForAgent,
): Promise<void> {
  if (process.env['HEAT_EVICTION_SHADOW_ENABLED'] !== 'true') return;

  try {
    const report = await sweepFn(supabase, agentId, opts);
    const { stats, evictionCandidates, reactivationCandidates, hot, warm, cold, onChain } = report;
    console.log(
      `[HEAT-EVICTION-SHADOW] ${agentId} ` +
        `hot=${stats.hotCount} warm=${stats.warmCount} cold=${stats.coldCount} ` +
        `on_chain=${stats.onChainCount} evict=${evictionCandidates.length} ` +
        `reactivate=${reactivationCandidates.length}`,
    );

    // Persist tier classifications — shadow-only (flag-gated through this caller).
    const tierMap = new Map<string, HeatTier>();
    for (const leaf of hot) tierMap.set(leaf.id, 'hot');
    for (const leaf of warm) tierMap.set(leaf.id, 'warm');
    for (const leaf of cold) tierMap.set(leaf.id, 'cold');
    for (const leaf of onChain) tierMap.set(leaf.id, 'on_chain');
    await writeHeatTiers(supabase, agentId, tierMap);
  } catch (err) {
    console.warn(`[HEAT-EVICTION-SHADOW] ${agentId} sweep error:`, err);
  }
}
