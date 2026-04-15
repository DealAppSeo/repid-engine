import { Router, Request, Response } from 'express';
import { db } from '../db';

const router = Router();

// GET /hal/stats — Track A live production statistics from hal_production_events
router.get('/hal/stats', async (_req: Request, res: Response) => {
  const { data, error } = await db
    .from('hal_production_events')
    .select('hal_verdict, pcv_vetoed, hal_mode, total_latency_ms, created_at')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) return res.status(500).json({ error: error.message });
  const total = data?.length || 0;
  const caught = data?.filter((e: any) => e.pcv_vetoed).length || 0;
  const avgLatency =
    total > 0
      ? data!.reduce((s: number, e: any) => s + (e.total_latency_ms || 0), 0) /
        total
      : 0;
  return res.json({
    totalInferences: total,
    hallucinationsCaught: caught,
    catchRate: total > 0 ? caught / total : 0,
    avgLatencyMs: Math.round(avgLatency),
    isLive: true,
    trackA: 'production — always running',
    lastUpdated: new Date().toISOString(),
  });
});

export default router;
