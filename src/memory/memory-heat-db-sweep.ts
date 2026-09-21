/**
 * Item 13 (hierarchical durable memory) — DB-backed heat-eviction sweep orchestrator.
 *
 * Fetches this agent's non-tombstoned leaves from `agent_memory_leaves` (with
 * `last_accessed_at` and `access_count` from the access-tracking migration), determines
 * which epochs are on-chain (via `agent_memory_roots.anchored_at`), maps rows to
 * `HeatLeaf[]`, then delegates to `runHeatEvictionSweep` for the pure classification.
 *
 * Shadow-first: this module only READS and REPORTS. No tombstoning, no root update.
 * A caller that wants real eviction must explicitly write those changes — this function
 * never does. The intended integration is a cron that calls this, logs the report under
 * HEAT_EVICTION_SHADOW_ENABLED, and does nothing else until Sean GO.
 *
 * All Supabase I/O is injected via `fetchFn` for testability — tests never touch a DB.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { runHeatEvictionSweep, type HeatEvictionReport, type HeatSweepOptions } from './memory-heat-sweep';
import type { HeatLeaf } from './memory-heat';

/** Shape of a row returned from `agent_memory_leaves` for the sweep. */
export interface AgentMemoryLeafRow {
  id: number | string;
  root_epoch: number | string;
  last_accessed_at: string;
  access_count: number;
}

/** Result of fetching leaves + anchored epochs for an agent. */
export interface FetchLeavesResult {
  rows: AgentMemoryLeafRow[];
  /** Set of root_epoch values whose roots have a non-null `anchored_at`. */
  anchoredEpochs: Set<number>;
}

/** Injected fetch function — real implementation queries Supabase; tests stub this. */
export type FetchLeavesFn = (supabase: SupabaseClient, agentId: string) => Promise<FetchLeavesResult>;

/**
 * Default fetch implementation: queries non-tombstoned leaves + anchored epochs in parallel.
 * Throws on any DB error so the caller can decide to log vs propagate.
 */
export async function fetchAgentLeaves(supabase: SupabaseClient, agentId: string): Promise<FetchLeavesResult> {
  const [leavesResult, rootsResult] = await Promise.all([
    supabase
      .from('agent_memory_leaves')
      .select('id, root_epoch, last_accessed_at, access_count')
      .eq('agent_id', agentId)
      .eq('tombstoned', false),
    supabase
      .from('agent_memory_roots')
      .select('root_epoch')
      .eq('agent_id', agentId)
      .not('anchored_at', 'is', null),
  ]);

  if (leavesResult.error) {
    throw new Error(`[HEAT-DB-SWEEP] leaves query failed: ${leavesResult.error.message}`);
  }
  if (rootsResult.error) {
    throw new Error(`[HEAT-DB-SWEEP] roots query failed: ${rootsResult.error.message}`);
  }

  const anchoredEpochs = new Set<number>(
    (rootsResult.data ?? []).map((r: { root_epoch: number | string }) => Number(r.root_epoch)),
  );

  return { rows: leavesResult.data ?? [], anchoredEpochs };
}

/**
 * Map DB rows to the pure `HeatLeaf[]` the sweep function expects.
 * Exported for testing — the row→leaf mapping is a correctness surface.
 */
export function rowsToHeatLeaves(rows: AgentMemoryLeafRow[], anchoredEpochs: Set<number>): HeatLeaf[] {
  return rows.map((row) => ({
    id: String(row.id),
    lastAccessedMs: new Date(row.last_accessed_at).getTime(),
    accessCount: row.access_count,
    isAnchored: anchoredEpochs.has(Number(row.root_epoch)),
  }));
}

/**
 * Fetch this agent's leaves from the DB and run the heat-eviction sweep.
 * Returns a `HeatEvictionReport` — caller is responsible for logging / acting on it.
 * Throws if the DB query fails; never tombstones or writes anything itself.
 */
export async function runHeatEvictionSweepForAgent(
  supabase: SupabaseClient,
  agentId: string,
  opts?: HeatSweepOptions,
  fetchFn: FetchLeavesFn = fetchAgentLeaves,
): Promise<HeatEvictionReport> {
  const { rows, anchoredEpochs } = await fetchFn(supabase, agentId);
  const leaves = rowsToHeatLeaves(rows, anchoredEpochs);
  return runHeatEvictionSweep(leaves, opts);
}
