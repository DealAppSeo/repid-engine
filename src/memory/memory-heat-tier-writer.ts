/**
 * Item 13 (hierarchical durable memory) — durable heat-tier writer.
 *
 * writeHeatTiers persists the `heat_tier` classification from a sweep report back
 * to `agent_memory_leaves` so the last sweep result is durable across process restarts.
 *
 * Shadow-first: this module only WRITES the classification column. It does not evict,
 * tombstone, promote, or change any other field. The `heat_tier` column is purely
 * informational until a future Sean-gated enforcer reads it.
 *
 * Called by logHeatSweepShadow after logging the summary line — the write is always
 * flag-gated (HEAT_EVICTION_SHADOW_ENABLED) through the caller, so this function
 * never runs in prod unless the shadow flag is on.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { HeatTier } from './memory-heat';

/**
 * Persist heat-tier classifications for an agent's leaves.
 *
 * Groups the input map by tier and issues one UPDATE per tier group (at most 4),
 * touching only non-tombstoned leaves owned by `agentId`. Returns the total number
 * of rows updated. Throws on any DB error so the caller can catch/warn.
 */
export async function writeHeatTiers(
  supabase: SupabaseClient,
  agentId: string,
  tiers: Map<string, HeatTier>,
): Promise<number> {
  if (tiers.size === 0) return 0;

  // Group leaf ids by tier to minimise round-trips (at most 4 UPDATE calls).
  const byTier = new Map<HeatTier, string[]>();
  for (const [id, tier] of tiers) {
    const existing = byTier.get(tier);
    if (existing) {
      existing.push(id);
    } else {
      byTier.set(tier, [id]);
    }
  }

  let rowsAffected = 0;
  for (const [tier, ids] of byTier) {
    const { error, data } = await supabase
      .from('agent_memory_leaves')
      .update({ heat_tier: tier })
      .eq('agent_id', agentId)
      .eq('tombstoned', false)
      .in('id', ids)
      .select('id');

    if (error) {
      throw new Error(`[HEAT-TIER-WRITER] update failed for tier ${tier}: ${error.message}`);
    }
    rowsAffected += (data as Array<{ id: unknown }> | null)?.length ?? 0;
  }

  return rowsAffected;
}
