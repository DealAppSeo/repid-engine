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
import type { NodeType } from '../types/graph-rag';

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
