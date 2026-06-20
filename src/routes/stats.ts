/**
 * GET /api/v1/stats — TrustShell.dev live tick feed (public, edge-cacheable ~10s).
 */
import { Router, Request, Response } from 'express';
import { fetchLiveStats } from '../services/live-stats';

const router = Router();
const CACHE_TTL_MS = Number(process.env.STATS_CACHE_TTL_MS || 10_000);
let cache: { at: number; payload: Awaited<ReturnType<typeof fetchLiveStats>> } | null = null;

router.get('/stats', async (_req: Request, res: Response) => {
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      res.set('Cache-Control', `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
      return res.json(cache.payload);
    }
    const payload = await fetchLiveStats();
    cache = { at: Date.now(), payload };
    res.set('Cache-Control', `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
    return res.json(payload);
  } catch (e: any) {
    return res.status(500).json({ error: 'stats_failed', detail: e?.message ?? String(e) });
  }
});

export function __clearStatsCache() {
  cache = null;
}
export default router;