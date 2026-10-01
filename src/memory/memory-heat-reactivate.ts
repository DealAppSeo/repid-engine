/**
 * Item 13 (hierarchical durable memory) — heat-reactivation writer.
 *
 * Promotes cold-tier leaves that have warmed back up (heat >= warm threshold)
 * to heat_tier='warm'. Complement of the eviction writer (memory-heat-evict.ts).
 *
 * Gated on HEAT_EVICTION_ENABLED (same flag as eviction — reactivation is only
 * meaningful when the eviction flag is on and actual cold-tier leaves exist).
 * When disabled, returns immediately with reactivatedCount=0 and skipped=true.
 *
 * Shadow-first: run the shadow log (memory-heat-shadow.ts) and eviction writer
 * before enabling this path. All Supabase I/O is injected for testability.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  runHeatEvictionSweepForAgent,
  type FetchLeavesFn,
} from './memory-heat-db-sweep';
import type { HeatSweepOptions } from './memory-heat-sweep';

export interface HeatReactivateResult {
  /** Number of leaves promoted to warm this run. */
  reactivatedCount: number;
  /** IDs of promoted leaves (stringified for uniformity). */
  reactivatedIds: string[];
  /** true when HEAT_EVICTION_ENABLED !== "true" — nothing was done. */
  skipped: boolean;
}

/**
 * Injected reactivation function — real impl updates agent_memory_leaves; tests stub it.
 * Returns the number of rows affected (0 or 1 per call).
 */
export type ReactivateLeafFn = (
  supabase: SupabaseClient,
  leafId: string,
) => Promise<number>;

/**
 * Default reactivation implementation: sets heat_tier='warm' on the given leaf row.
 * Only updates rows that are currently 'cold' to avoid double-promotion.
 * Throws on Supabase error so the caller can decide whether to continue or abort.
 */
export async function reactivateLeaf(
  supabase: SupabaseClient,
  leafId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from('agent_memory_leaves')
    .update({ heat_tier: 'warm' })
    .eq('id', leafId)
    .eq('heat_tier', 'cold')
    .select('id');

  if (error) {
    throw new Error(`[HEAT-REACTIVATE] reactivate leaf ${leafId} failed: ${error.message}`);
  }
  return (data ?? []).length;
}

/**
 * Promote warm-enough cold-tier leaves back to 'warm' for an agent.
 *
 * Returns immediately with skipped=true when HEAT_EVICTION_ENABLED !== "true".
 * Otherwise runs the sweep, promotes each reactivation candidate in sequence, and
 * returns the count and IDs of promoted leaves.
 *
 * Errors from individual reactivation calls are propagated — caller decides retry policy.
 */
export async function reactivateLeaves(
  supabase: SupabaseClient,
  agentId: string,
  opts?: HeatSweepOptions,
  fetchFn?: FetchLeavesFn,
  reactivateFn: ReactivateLeafFn = reactivateLeaf,
): Promise<HeatReactivateResult> {
  if (process.env['HEAT_EVICTION_ENABLED'] !== 'true') {
    return { reactivatedCount: 0, reactivatedIds: [], skipped: true };
  }

  const report = await runHeatEvictionSweepForAgent(supabase, agentId, opts, fetchFn);
  const reactivatedIds: string[] = [];

  for (const candidate of report.reactivationCandidates) {
    const affected = await reactivateFn(supabase, candidate.id);
    if (affected > 0) {
      reactivatedIds.push(candidate.id);
    }
  }

  return {
    reactivatedCount: reactivatedIds.length,
    reactivatedIds,
    skipped: false,
  };
}
