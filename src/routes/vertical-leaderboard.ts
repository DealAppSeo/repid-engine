/**
 * GET /api/v1/leaderboard/vertical — Trinity 12 overall + per-vertical ranks (public).
 */
import { Router, Request, Response } from 'express';
import { fetchVerticalLeaderboard } from '../services/vertical-leaderboard';

const router = Router();
const CACHE_TTL_MS = Number(process.env.STATS_CACHE_TTL_MS || 10_000);
let cache: { at: number; payload: Awaited<ReturnType<typeof fetchVerticalLeaderboard>> } | null = null;

router.get('/leaderboard/vertical', async (_req: Request, res: Response) => {
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      res.set('Cache-Control', `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
      return res.json(cache.payload);
    }
    const payload = await fetchVerticalLeaderboard();
    cache = { at: Date.now(), payload };
    res.set('Cache-Control', `public, max-age=${Math.floor(CACHE_TTL_MS / 1000)}`);
    return res.json(payload);
  } catch (e: any) {
    return res.status(500).json({ error: 'vertical_leaderboard_failed', detail: e?.message ?? String(e) });
  }
});

export function __clearVerticalLeaderboardCache() {
  cache = null;
}
export default router;