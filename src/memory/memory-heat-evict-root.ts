/**
 * Item 13 (hierarchical durable memory) — evict-and-update-root orchestrator.
 *
 * Calls performHeatEviction to tombstone cold leaves, then recomputes and stores
 * the new LeanIMT+ root in `agent_memory_roots` so the commitment remains valid
 * after eviction. This is the "root preserved" leg of item 13's acceptance test.
 *
 * Gated on HEAT_EVICTION_ENABLED (inherits from performHeatEviction). If nothing
 * is evicted (flag off, or no cold candidates), root is not touched.
 *
 * All DB I/O is injected for testability.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { performHeatEviction, type EvictLeafFn, type HeatEvictResult } from './memory-heat-evict';
import { recomputeRoot, type MemoryLeafRow } from './memory-root-store';
import type { FetchLeavesFn } from './memory-heat-db-sweep';
import type { HeatSweepOptions } from './memory-heat-sweep';

export interface EvictAndUpdateRootResult extends HeatEvictResult {
  /** Recomputed root after tombstoning. Absent when nothing was evicted or flag is off. */
  newRoot?: string;
  /** Epoch written to agent_memory_roots. Absent when no root was stored. */
  newEpoch?: number;
}

/** Fetch non-tombstoned leaves for root recomputation after eviction. */
export type FetchRootLeavesFn = (
  supabase: SupabaseClient,
  agentId: string,
) => Promise<MemoryLeafRow[]>;

/** Insert new root row; returns the epoch stored. */
export type StoreRootFn = (
  supabase: SupabaseClient,
  agentId: string,
  root: string,
  leafCount: number,
) => Promise<number>;

export async function defaultFetchRootLeaves(
  supabase: SupabaseClient,
  agentId: string,
): Promise<MemoryLeafRow[]> {
  const { data, error } = await supabase
    .from('agent_memory_leaves')
    .select('leaf_index, value, next, tombstoned')
    .eq('agent_id', agentId)
    .eq('tombstoned', false)
    .order('leaf_index');
  if (error) {
    throw new Error(`[HEAT-EVICT-ROOT] fetch leaves failed: ${error.message}`);
  }
  return (data ?? []) as MemoryLeafRow[];
}

export async function defaultStoreRoot(
  supabase: SupabaseClient,
  agentId: string,
  root: string,
  leafCount: number,
): Promise<number> {
  const { data: epochData, error: epochError } = await supabase
    .from('agent_memory_roots')
    .select('epoch')
    .eq('agent_id', agentId)
    .order('epoch', { ascending: false })
    .limit(1);
  if (epochError) {
    throw new Error(`[HEAT-EVICT-ROOT] fetch max epoch failed: ${epochError.message}`);
  }
  const topRow = epochData?.[0];
  const newEpoch = topRow !== undefined ? Number(topRow.epoch) + 1 : 1;

  const { error: insertError } = await supabase
    .from('agent_memory_roots')
    .insert({ agent_id: agentId, epoch: newEpoch, root, leaf_count: leafCount });
  if (insertError) {
    throw new Error(`[HEAT-EVICT-ROOT] store root failed: ${insertError.message}`);
  }
  return newEpoch;
}

/**
 * Tombstone cold leaves, then recompute and persist the new Merkle root.
 *
 * Returns immediately (skipped=true) when HEAT_EVICTION_ENABLED !== "true".
 * If eviction runs but finds no cold candidates, returns evictedCount=0 with no
 * root update (the existing root is still valid).
 */
export async function evictAndUpdateRoot(
  supabase: SupabaseClient,
  agentId: string,
  opts?: HeatSweepOptions,
  fetchFn?: FetchLeavesFn,
  evictLeafFn?: EvictLeafFn,
  fetchRootLeavesFn: FetchRootLeavesFn = defaultFetchRootLeaves,
  storeRootFn: StoreRootFn = defaultStoreRoot,
): Promise<EvictAndUpdateRootResult> {
  const evictResult = await performHeatEviction(supabase, agentId, opts, fetchFn, evictLeafFn);

  if (evictResult.skipped || evictResult.evictedCount === 0) {
    return { ...evictResult };
  }

  const remainingLeaves = await fetchRootLeavesFn(supabase, agentId);
  const newRoot = recomputeRoot(remainingLeaves);
  const newEpoch = await storeRootFn(supabase, agentId, newRoot, remainingLeaves.length);

  return { ...evictResult, newRoot, newEpoch };
}
