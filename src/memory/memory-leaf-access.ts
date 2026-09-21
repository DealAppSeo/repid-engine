/**
 * memory-leaf-access.ts — fire-and-forget access tracking for agent_memory_leaves.
 *
 * Called by GET /api/v1/memory/retrieve after a successful response. Never awaited —
 * a slow or failing RPC must not block the retrieval response the agent already got.
 *
 * Calls record_leaf_access(p_agent_id) — a SECURITY DEFINER function in the migration
 * (20260920000000_agent_memory_leaf_access_tracking.sql) that does the atomic
 * `SET access_count = access_count + 1, last_accessed_at = now()` for all non-tombstoned
 * leaves belonging to this agent. The RPC returns the number of rows updated.
 *
 * Why a DB function instead of a client UPDATE:
 *   Supabase JS `.update({access_count: x})` requires the caller to know the current value.
 *   A relative increment (`access_count + 1`) is only expressible atomically in SQL.
 *   Using a function avoids a read-modify-write race across concurrent retrievals.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/** Rows updated, or -1 on error (caller ignores; here for testability). */
export async function recordLeafAccess(supabase: SupabaseClient, agentId: string): Promise<number> {
  try {
    const { data, error } = await supabase.rpc('record_leaf_access', { p_agent_id: agentId });
    if (error) {
      console.warn('[MEMORY-LEAF-ACCESS] rpc failed:', error.message);
      return -1;
    }
    return typeof data === 'number' ? data : -1;
  } catch (e: any) {
    console.warn('[MEMORY-LEAF-ACCESS] unexpected error:', e?.message);
    return -1;
  }
}
