/**
 * proof-carrying-emit.ts — the "emit" half of backlog item 4 (answer-binding) over persisted
 * memory: an authenticated caller supplies an answer + the values it cites, this route fetches
 * that agent's own committed root/leaves/content (the identical fetch `memory-retrieve.ts`
 * already uses) and gates emission through `bindAnswerFromRetrieval` — no verified proof-set,
 * no answer, out of this route. Mounted at `POST /api/v1/proof-carrying/emit` (same prefix as
 * `proof-carrying-verify.ts`'s `/api/v1/proof-carrying/verify`).
 *
 * Identity comes ONLY from `(req as any).agent_id`, set by `middleware/auth.ts` only for a
 * DB-issued key — never from the request body — the same contract `memory-retrieve.ts` uses,
 * so one agent can never emit a bound answer over another agent's memory root.
 *
 * JSON transport note: mirrors `memory-retrieve.ts` — the returned `ProofCarryingAnswer`'s
 * citation witnesses carry `bigint` leaf fields, stringified before `res.json`.
 */
import express from 'express';
import { db } from '../db';
import { bindAnswerFromRetrieval } from '../memory/answer-binding-retrieval';
import { retrieveVerifiedMemory } from '../memory/memory-retrieval';
import type { MemoryLeafRow } from '../memory/memory-root-store';
import type { MemoryContentRow } from '../memory/memory-content-store';

const router = express.Router();

function toWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

router.post('/emit', async (req, res) => {
  const agentId = (req as any).agent_id;
  if (!agentId) {
    return res.status(403).json({ error: 'Forbidden: this endpoint requires a DB-issued agent API key bound to an agent identity' });
  }

  const body = req.body;
  const answer = typeof body?.answer === 'string' ? body.answer : null;
  const citedValues: string[] = Array.isArray(body?.cited_values)
    ? body.cited_values.filter((v: unknown): v is string => typeof v === 'string')
    : [];
  if (!answer || citedValues.length === 0) {
    return res.status(400).json({ error: 'body must be { answer: string, cited_values: string[] } with at least one cited value' });
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
    return res.status(409).json({ error: 'abstain: this agent has no committed memory root to cite' });
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
    const retrieval = retrieveVerifiedMemory(
      (leafRows ?? []) as MemoryLeafRow[],
      (contentRows ?? []) as MemoryContentRow[],
      rootRow.root,
    );
    const pca = bindAnswerFromRetrieval(answer, citedValues, retrieval);
    res.json(toWire(pca));
  } catch (e: any) {
    res.status(409).json({ error: 'abstain: could not bind answer to a verified proof set', detail: e?.message });
  }
});

export default router;
