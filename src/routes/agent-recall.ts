// Public Graph RAG recall surface for agents.
//
// Routes (mounted at /api/v1 in src/index.ts):
//   GET /api/v1/agents/:id/recall?q=&k=&types=&threshold=
//     Semantic retrieval of memory nodes by similarity to query.
//   GET /api/v1/agents/:id/memory/recent?limit=20
//     Chronological feed of the agent's N most recent memory nodes.
//
// Both routes are PUBLIC reads — no auth. Bypass entry added in
// src/middleware/auth.ts.
import { Router, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RetrievalService } from '../services/graph-rag/retrieval-service';
import { GraphRagStore } from '../services/graph-rag/graph-rag-store';
import { LESSON_SCOPES, type NodeType } from '../types/graph-rag';

const ALLOWED_NODE_TYPES: NodeType[] = [
  'observation',
  'decision',
  'fact',
  'preference',
  'goal',
  'interaction',
  'reflection',
];

export function createAgentRecallRouter(supabase: SupabaseClient): Router {
  const router = Router();
  const retrieval = new RetrievalService(supabase);
  const store = new GraphRagStore(supabase);

  /**
   * GET /api/v1/lessons/recall?scope=&q=&k=&threshold=
   *
   * Agent-independent lesson retrieval. This is what the XC/GA dispatcher calls
   * to append scoped context beneath the unconditional LESSONS.md block, so it
   * is a PUBLIC read: making the dispatcher hold an API key to read its own
   * lessons adds a failure mode without adding safety (the content is the same
   * lessons already injected verbatim into every dispatch).
   *
   * Defaults to node_type 'reflection' — lessons are stored there, and the
   * filter keeps them isolated from the HAL fixture data under agent scopes.
   */
  router.get('/lessons/recall', async (req: Request, res: Response) => {
    try {
      const scope = String(req.query.scope ?? 'global');
      if (!(LESSON_SCOPES as readonly string[]).includes(scope)) {
        res.status(400).json({
          error: 'unknown_scope',
          message: `scope must be one of: ${LESSON_SCOPES.join(', ')}`,
        });
        return;
      }
      const query = String(req.query.q ?? '').slice(0, 1000);
      if (!query) {
        res.status(400).json({ error: 'q parameter required' });
        return;
      }
      const topK = Math.max(
        1,
        Math.min(20, parseInt(String(req.query.k ?? '5'), 10) || 5)
      );
      const threshold = Math.max(
        0.3,
        Math.min(0.95, parseFloat(String(req.query.threshold ?? '0.65')) || 0.65)
      );
      const rawTypes = String(req.query.types ?? 'reflection')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as NodeType[];
      const types = rawTypes.filter((t) =>
        (ALLOWED_NODE_TYPES as string[]).includes(t)
      );

      const results = await retrieval.retrieveScoped({
        scope,
        query,
        top_k: topK,
        similarity_threshold: threshold,
        include_related: false,
        node_types: types.length > 0 ? types : ['reflection'],
      });

      res.status(200).json({
        scope,
        query,
        result_count: results.length,
        results: results.map((r) => ({
          similarity: r.similarity,
          content: r.node.content,
          importance: r.node.importance,
          created_at: r.node.created_at,
          metadata: r.node.metadata,
        })),
        generated_at: new Date().toISOString(),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[agent-recall] scoped recall failed:', msg);
      res.status(500).json({ error: 'recall_failed', message: msg });
    }
  });

  /**
   * POST /api/v1/lessons  { scope, content, metadata? , importance? }
   *
   * Writes one scoped lesson. AUTHED — unlike the read, this mutates shared
   * state every future dispatch will be shown. Called by the dispatch
   * harvester when an agent ends its report with a LESSON: block.
   */
  router.post('/lessons', async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const scope = String(body.scope ?? 'global');
      if (!(LESSON_SCOPES as readonly string[]).includes(scope)) {
        res.status(400).json({
          error: 'unknown_scope',
          message: `scope must be one of: ${LESSON_SCOPES.join(', ')}`,
        });
        return;
      }
      const content = String(body.content ?? '').trim();
      if (content.length < 20) {
        // A one-word "lesson" is noise that would rank against real ones forever.
        res.status(400).json({
          error: 'content_too_short',
          message: 'lesson content must be at least 20 characters',
        });
        return;
      }

      const node = await store.createNode({
        scope,
        node_type: 'reflection',
        content: content.slice(0, 4000),
        importance:
          typeof body.importance === 'number'
            ? Math.max(0, Math.min(1, body.importance))
            : 0.7,
        metadata: {
          ...(typeof body.metadata === 'object' && body.metadata !== null
            ? (body.metadata as Record<string, unknown>)
            : {}),
          source: 'dispatch_lesson_harvester',
        },
      });

      res.status(201).json({ id: node.id, scope, node_type: 'reflection' });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[agent-recall] lesson write failed:', msg);
      res.status(500).json({ error: 'lesson_write_failed', message: msg });
    }
  });

  /**
   * GET /api/v1/agents/:id/recall
   *
   * Query params:
   *   q          (required) — the natural-language query
   *   k          (optional, default 5, max 20) — top-K results
   *   threshold  (optional, default 0.5, range 0.3-0.95) — minimum cosine similarity
   *   types      (optional, comma-separated) — filter by node_type values
   *
   * Public; no auth.
   */
  router.get('/agents/:id/recall', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const query = String(req.query.q ?? '').slice(0, 1000);
      if (!query) {
        res.status(400).json({ error: 'q parameter required' });
        return;
      }
      const topK = Math.max(
        1,
        Math.min(20, parseInt(String(req.query.k ?? '5'), 10) || 5)
      );
      const threshold = Math.max(
        0.3,
        Math.min(0.95, parseFloat(String(req.query.threshold ?? '0.5')) || 0.5)
      );
      const rawTypes = String(req.query.types ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean) as NodeType[];
      const types = rawTypes.filter((t) =>
        (ALLOWED_NODE_TYPES as string[]).includes(t)
      );

      const results = await retrieval.retrieve({
        agent_id: id,
        query,
        top_k: topK,
        similarity_threshold: threshold,
        include_related: true,
        node_types: types.length > 0 ? types : undefined,
      });

      res.status(200).json({
        agent_id: id,
        query,
        top_k: topK,
        similarity_threshold: threshold,
        node_types: types.length > 0 ? types : null,
        result_count: results.length,
        results: results.map((r) => ({
          similarity: r.similarity,
          node: {
            id: r.node.id,
            type: r.node.node_type,
            content: r.node.content,
            importance: r.node.importance,
            created_at: r.node.created_at,
            access_count: r.node.access_count,
            metadata: r.node.metadata,
          },
          related: r.related_nodes.map((rel) => ({
            edge_type: rel.edge_type,
            weight: rel.weight,
            node_id: rel.node.id,
            node_type: rel.node.node_type,
            content: rel.node.content,
          })),
        })),
        generated_at: new Date().toISOString(),
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[agent-recall] retrieve failed:', msg);
      res.status(500).json({ error: 'recall_failed', message: msg });
    }
  });

  /**
   * GET /api/v1/agents/:id/memory/recent?limit=20
   *
   * Chronological feed of the agent's N most-recent memory nodes.
   * No query needed — useful for a "what does this agent remember?" UI.
   * Public; no auth.
   */
  router.get('/agents/:id/memory/recent', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      const limit = Math.max(
        1,
        Math.min(50, parseInt(String(req.query.limit ?? '20'), 10) || 20)
      );

      const { data, error } = await supabase
        .from('agent_memory_nodes')
        .select(
          'id, node_type, content, importance, created_at, access_count, metadata'
        )
        .eq('agent_id', id)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) throw new Error(error.message);

      res.status(200).json({
        agent_id: id,
        limit,
        count: data?.length ?? 0,
        nodes: data ?? [],
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[agent-recall] recent failed:', msg);
      res.status(500).json({ error: 'recent_failed', message: msg });
    }
  });

  return router;
}
