/**
 * memory-heat-evict-route.ts — POST trigger for item 13 heat eviction + root update.
 *
 * Calls evictAndUpdateRoot for the authenticated agent's ID.
 * When HEAT_EVICTION_ENABLED !== "true" the primitive returns skipped:true and
 * no leaf is tombstoned — prod safe with the flag off (default).
 *
 * Identity from (req as any).agent_id only — same contract as memory-retrieve.ts.
 * Enabling in prod requires Sean flipping HEAT_EVICTION_ENABLED=true in Railway.
 */
import express from 'express';
import { db } from '../db';
import { evictAndUpdateRoot } from '../memory/memory-heat-evict-root';

const router = express.Router();

router.post('/memory/evict', async (req, res) => {
  const agentId = (req as any).agent_id;
  if (!agentId) {
    return res.status(403).json({ error: 'Forbidden: this endpoint requires a DB-issued agent API key bound to an agent identity' });
  }

  try {
    const result = await evictAndUpdateRoot(db, agentId);
    return res.json({
      agent_id: agentId,
      skipped: result.skipped,
      evicted_count: result.evictedCount,
      evicted_ids: result.evictedIds,
      new_root: result.newRoot ?? null,
      new_epoch: result.newEpoch ?? null,
    });
  } catch (e: any) {
    return res.status(500).json({ error: 'eviction failed', detail: e?.message });
  }
});

export default router;
