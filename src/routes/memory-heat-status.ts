/**
 * memory-heat-status.ts — read-only heat-classification view for an agent's own leaves.
 *
 * Item 13 (hierarchical durable memory): makes heat tier classification observable in
 * prod without any real eviction or tombstoning. Calls `runHeatEvictionSweepForAgent`
 * and returns tier counts + candidate counts.
 *
 * Identity from `(req as any).agent_id` only — same contract as memory-retrieve.ts.
 * An env-allowlist key with no bound agent gets 403, not another agent's heat state.
 * Shadow-only: no writes, no tombstoning, no scoring side-effects.
 */
import express from 'express';
import { db } from '../db';
import { runHeatEvictionSweepForAgent } from '../memory/memory-heat-db-sweep';

const router = express.Router();

router.get('/memory/heat-status', async (req, res) => {
  const agentId = (req as any).agent_id;
  if (!agentId) {
    return res.status(403).json({ error: 'Forbidden: this endpoint requires a DB-issued agent API key bound to an agent identity' });
  }

  try {
    const report = await runHeatEvictionSweepForAgent(db, agentId);
    return res.json({
      agent_id: agentId,
      tiers: {
        hot: report.stats.hotCount,
        warm: report.stats.warmCount,
        cold: report.stats.coldCount,
        on_chain: report.stats.onChainCount,
        total: report.stats.total,
      },
      eviction_candidates: report.evictionCandidates.length,
      reactivation_candidates: report.reactivationCandidates.length,
    });
  } catch (e: any) {
    return res.status(500).json({ error: 'heat sweep failed', detail: e?.message });
  }
});

export default router;
