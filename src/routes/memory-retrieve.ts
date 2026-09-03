/**
 * memory-retrieve.ts — the authenticated retrieval half of backlog item 3 (P2 retrieval API),
 * the last piece named by beats 88-90: an HTTP caller in, a verified `VerifiedRetrieval` out.
 *
 * Fetches this agent's own latest committed root (`agent_memory_roots`, `order by epoch desc
 * limit 1` — "the last root this agent committed", per that migration's own comment), the
 * leaf rows at that epoch (`agent_memory_leaves`), and this agent's content rows
 * (`agent_memory_leaf_content`, fetched un-scoped by epoch since content is content-addressed
 * and can recur across epochs — see that migration's header), then hands all three to the
 * pure `retrieveVerifiedMemory` bridge. That function is the only place trust decisions are
 * made; this route is just the fetch + wire-format boundary around it.
 *
 * Identity comes ONLY from `(req as any).agent_id`, which `middleware/auth.ts` sets only for
 * a DB-issued key — never from a client-supplied field in the request. An env-allowlist key
 * (no bound agent) gets a 403, not another agent's memory; this is the same buyer/provider-id
 * confusion class PR #529/#570 already fixed once in this codebase, avoided here by never
 * reading an id off the request at all.
 *
 * JSON transport note: `InclusionWitness.leaf.{value,next}` are `bigint` in-process (JSON has
 * no bigint type) — the mirror image of `proof-carrying-verify.ts`'s own note, which revives
 * the wire format back to bigint; this route goes the other direction, stringifying before
 * `res.json`.
 */
import express from 'express';
import { db } from '../db';
import { retrieveVerifiedMemory } from '../memory/memory-retrieval';
import type { MemoryLeafRow } from '../memory/memory-root-store';
import type { MemoryContentRow } from '../memory/memory-content-store';

const router = express.Router();

function toWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

router.get('/memory/retrieve', async (req, res) => {
  const agentId = (req as any).agent_id;
  if (!agentId) {
    return res.status(403).json({ error: 'Forbidden: this endpoint requires a DB-issued agent API key bound to an agent identity' });
  }

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
    return res.json({ root: null, entries: [] });
  }

  const { data: leafRows, error: leafErr } = await db
    .from('agent_memory_leaves')
    .select('leaf_index, value, next, tombstoned')
    .eq('agent_id', agentId)
    .eq('root_epoch', rootRow.epoch);
  if (leafErr) {
    return res.status(500).json({ error: 'failed to fetch leaf rows' });
  }

  const { data: contentRows, error: contentErr } = await db
    .from('agent_memory_leaf_content')
    .select('value, content, source_id, source_repid, hal_verdict, epoch')
    .eq('agent_id', agentId);
  if (contentErr) {
    return res.status(500).json({ error: 'failed to fetch content rows' });
  }

  try {
    const result = retrieveVerifiedMemory(
      (leafRows ?? []) as MemoryLeafRow[],
      (contentRows ?? []) as MemoryContentRow[],
      rootRow.root,
    );
    res.json(toWire(result));
  } catch (e: any) {
    res.status(409).json({ error: 'stored leaf rows do not recompute to the committed root', detail: e?.message });
  }
});

export default router;
