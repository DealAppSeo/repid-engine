/**
 * GET /api/v1/experimental/agents/:id/scores — an agent's EXPERIMENTAL RepID, per dimension and mode.
 *
 * Read-only, from the repid_experimental_scores view (migration 20261102140000). Every response carries
 * the fixed label: this is same-controller measured evidence, never independent reputation and never
 * canonical RepID. A failed read (for example the migration not applied yet) is 503 NOT_CHECKED, not zero.
 */
import { Router, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { db } from '../db';
import { EXPERIMENTAL_DOMAIN, EXPERIMENTAL_LABEL, EXPERIMENTAL_SCORES_VIEW, UUID_RE } from '../services/experimental-repid';

export function experimentalScoresRouter(client: Pick<SupabaseClient, 'from'> = db): Router {
  const router = Router();
  router.get('/agents/:id/scores', async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    const base = { agent_id: id, domain: EXPERIMENTAL_DOMAIN, label: EXPERIMENTAL_LABEL, independent_reputation: false };
    if (!UUID_RE.test(id)) {
      res.status(400).json({ ...base, error: 'id must be a repid_agents uuid' });
      return;
    }
    try {
      const { data, error } = await client
        .from(EXPERIMENTAL_SCORES_VIEW)
        .select('dimension, mode, n, score, n_same_controller_measured, n_independent_counterparty, scoring_versions, last_event_at')
        .eq('domain', EXPERIMENTAL_DOMAIN)
        .eq('agent_id', id);
      if (error || !data) throw new Error(error?.message ?? 'no data');
      res.status(200).json({
        ...base,
        scores: data.map((r: Record<string, unknown>) => ({
          dimension: r.dimension,
          mode: r.mode,
          n: Number(r.n),
          score: Number(r.score),
          eligibility: {
            same_controller_measured: Number(r.n_same_controller_measured),
            independent_counterparty: Number(r.n_independent_counterparty),
          },
          scoring_versions: r.scoring_versions,
          last_event_at: r.last_event_at,
        })),
      });
    } catch {
      res.status(503).json({ ...base, status: 'NOT_CHECKED', scores: null });
    }
  });
  return router;
}

export default experimentalScoresRouter();
