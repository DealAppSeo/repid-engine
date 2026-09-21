/**
 * Item 13 (hierarchical durable memory) — heat-eviction writer.
 *
 * Tombstones cold-tier leaves identified by the heat-eviction sweep.
 * Gated on HEAT_EVICTION_ENABLED (default off) — no leaf is ever tombstoned
 * unless the flag is explicitly set to "true". When disabled, returns immediately
 * with evictedCount=0 and an empty list.
 *
 * Shadow-first: the sweep + shadow-log (memory-heat-shadow.ts) can run for any
 * length of time before this module is ever called with the flag on.
 *
 * All Supabase I/O is injected via fetchFn / evictLeafFn for testability.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  runHeatEvictionSweepForAgent,
  type FetchLeavesFn,
} from './memory-heat-db-sweep';
import type { HeatSweepOptions } from './memory-heat-sweep';

export interface HeatEvictResult {
  /** Number of leaves actually tombstoned this run. */
  evictedCount: number;
  /** IDs of tombstoned leaves (stringified for uniformity). */
  evictedIds: string[];
  /** true when HEAT_EVICTION_ENABLED !== "true" — nothing was done. */
  skipped: boolean;
}

/**
 * Injected tombstone function — real impl updates agent_memory_leaves; tests stub it.
 * Returns the number of rows affected (0 or 1 per call).
 */
export type EvictLeafFn = (
  supabase: SupabaseClient,
  leafId: string,
) => Promise<number>;

/**
 * Default tombstone implementation: sets tombstoned=true on the given leaf row.
 * Throws on Supabase error so the caller can decide whether to continue or abort.
 */
export async function tombstoneLeaf(
  supabase: SupabaseClient,
  leafId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('agent_memory_leaves')
    .update({ tombstoned: true })
    .eq('id', leafId)
    .eq('tombstoned', false)
    .select('id');

  if (error) {
    throw new Error(`[HEAT-EVICT] tombstone leaf ${leafId} failed: ${error.message}`);
  }
  return (data ?? []).length;
}

/**
 * Tombstone cold-tier eviction candidates for an agent.
 *
 * Returns immediately with skipped=true when HEAT_EVICTION_ENABLED !== "true".
 * Otherwise runs the sweep, tombstones each eviction candidate in sequence, and
 * returns the count and IDs of tombstoned leaves.
 *
 * Errors from individual tombstone calls are propagated — caller decides retry policy.
 */
export async function performHeatEviction(
  supabase: SupabaseClient,
  agentId: string,
  opts?: HeatSweepOptions,
  fetchFn?: FetchLeavesFn,
  evictLeafFn: EvictLeafFn = tombstoneLeaf,
): Promise<HeatEvictResult> {
  if (process.env['HEAT_EVICTION_ENABLED'] !== 'true') {
    return { evictedCount: 0, evictedIds: [], skipped: true };
  }

  const report = await runHeatEvictionSweepForAgent(supabase, agentId, opts, fetchFn);
  const evictedIds: string[] = [];

  for (const candidate of report.evictionCandidates) {
    const affected = await evictLeafFn(supabase, candidate.id);
    if (affected > 0) {
      evictedIds.push(candidate.id);
    }
  }

  return {
    evictedCount: evictedIds.length,
    evictedIds,
    skipped: false,
  };
}
