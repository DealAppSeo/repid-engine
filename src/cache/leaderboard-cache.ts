/**
 * S-CACHE Phase 3 — leaderboard cache. The leaderboard aggregates across all trustchat_sessions;
 * cache the computed payload in DragonflyDB for 60s so the heavy aggregate isn't recomputed per
 * request (and the result is shared across instances + survives restarts). Graceful no-op without Redis.
 */
import { cacheGet, cacheSet } from './dragonfly';

const LEADERBOARD_TTL = 60; // seconds
const LEADERBOARD_KEY = 'leaderboard:v1';

export async function getCachedLeaderboard(): Promise<any | null> {
  const cached = await cacheGet(LEADERBOARD_KEY);
  if (!cached) return null;
  try { return JSON.parse(cached); } catch { return null; }
}

export async function cacheLeaderboard(data: any): Promise<void> {
  await cacheSet(LEADERBOARD_KEY, JSON.stringify(data), LEADERBOARD_TTL);
}
