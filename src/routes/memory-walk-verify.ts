/**
 * memory-walk-verify.ts — authenticated multi-hop walk verifier (backlog item 12 HTTP layer).
 *
 * POST /api/v1/memory/verify-walk
 * Body: { steps: WalkStep[] }
 *
 * Fetches this agent's latest committed root + leaf rows (same DB queries as memory-retrieve),
 * hydrates a live LeanIMTPlus via hydrateTree(), then calls verifyAuthenticatedWalk(steps, tree)
 * to verify each hop's edge-hash consistency AND inclusion witnesses against the root.
 *
 * Identity from bearer key only — same contract as memory-retrieve: never from a client-supplied
 * field (avoids the buyer/provider-id confusion class fixed in PR #529/#570).
 *
 * Serialization note: step `from_value`/`to_value` are BigInt string representations on the
 * wire (same as InclusionWitness fields in memory-retrieve); they are re-parsed to BigInt
 * internally by verifyAuthenticatedWalk via `BigInt(step.from_value)`.
 */
import express from 'express';
import { db } from '../db';
import { hydrateTree } from '../memory/memory-root-store';
import { verifyAuthenticatedWalk } from '../memory/graphrag-leaf-schema';
import type { WalkStep } from '../memory/graphrag-leaf-schema';
import type { MemoryLeafRow } from '../memory/memory-root-store';

const router = express.Router();

router.post('/memory/verify-walk', async (req, res) => {
  const agentId = (req as any).agent_id;
  if (!agentId) {
    return res.status(403).json({ error: 'Forbidden: this endpoint requires a DB-issued agent API key bound to an agent identity' });
  }

  const { steps } = req.body ?? {};
  if (!Array.isArray(steps)) {
    return res.status(400).json({ error: 'body.steps must be an array' });
  }

  // Fetch latest committed root for this agent
  const { data: rootRow, error: rootErr } = await db
    .from('agent_memory_roots')
    .select('epoch, root')
    .eq('agent_id', agentId)
    .order('epoch', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (rootErr) {
    return res.status(500).json({ error: 'failed to fetch latest committed root' });
  }
  if (!rootRow) {
    return res.status(409).json({ error: 'no committed memory root for this agent', valid: false });
  }

  // Fetch leaf rows at this epoch to hydrate the tree
  const { data: leafRows, error: leafErr } = await db
    .from('agent_memory_leaves')
    .select('leaf_index, value, next, tombstoned')
    .eq('agent_id', agentId)
    .eq('root_epoch', rootRow.epoch);
  if (leafErr) {
    return res.status(500).json({ error: 'failed to fetch leaf rows' });
  }

  let tree;
  try {
    tree = hydrateTree((leafRows ?? []) as MemoryLeafRow[]);
  } catch (e: any) {
    return res.status(409).json({ error: 'failed to hydrate tree from stored leaves', detail: e?.message });
  }

  const result = verifyAuthenticatedWalk(steps as WalkStep[], tree);
  return res.json(result);
});

export default router;
