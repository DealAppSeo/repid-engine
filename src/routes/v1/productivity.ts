/**
 * productivity.ts — GET /api/v1/observability/productivity-stack (CC1, 2026-05-26).
 *
 * Returns the productivity-stack metrics: ANFIS routing distribution (SLM / cheap-LLM /
 * expensive-LLM), SLM cost saved (24h), Firecrawl usage by agent + cost, total external
 * API spend (24h), and per-agent productivity (tasks completed / cost). Computed by the
 * shared cron-runners.computeProductivityStack so the cron snapshot and this endpoint
 * always agree. Mounted AFTER authMiddleware — this exposes cost/spend data (not public).
 */
import { Router, Request, Response } from 'express';
import { db } from '../../db';
import { computeProductivityStack } from '../../observability/cron-runners';

const router = Router();

router.get('/productivity-stack', async (_req: Request, res: Response) => {
  try {
    res.json(await computeProductivityStack(db));
  } catch (e: any) {
    res.status(500).json({ error: 'productivity_stack_failed', message: e?.message ?? 'unknown' });
  }
});

export default router;
