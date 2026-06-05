/**
 * S-CACHE Phase 9 — GET /api/v1/cache/stats. Public read: connection state, HAL cache hit-rate,
 * per-provider health, and Redis memory/stats info. Degrades to {status:'not_connected'} without Redis.
 */
import { Router, Request, Response } from 'express';
import { getCache, cacheEnabled } from '../cache/dragonfly';
import { getHalCacheStats } from '../cache/hal-cache';
import { getProviderHealth } from '../cache/provider-health';

const router = Router();

/** Parse a couple of fields out of redis INFO text (best-effort). */
function pickInfo(info: string, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of info.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) { const k = line.slice(0, i); if (keys.includes(k)) out[k] = line.slice(i + 1).trim(); }
  }
  return out;
}

router.get('/cache/stats', async (_req: Request, res: Response) => {
  const c = getCache();
  if (!cacheEnabled() || !c) {
    return res.json({ status: 'not_connected', note: 'REDIS_URL unset or unreachable — cache layer is a no-op (graceful)' });
  }
  try {
    const [hal, groq, cerebras, fireworks, anthropic, openai] = await Promise.all([
      getHalCacheStats(),
      getProviderHealth('groq'), getProviderHealth('cerebras'), getProviderHealth('fireworks'),
      getProviderHealth('anthropic'), getProviderHealth('openai'),
    ]);
    let memory: Record<string, string> = {};
    let stats: Record<string, string> = {};
    try { memory = pickInfo(await c.info('memory'), ['used_memory_human', 'maxmemory_human']); } catch { /* ignore */ }
    try { stats = pickInfo(await c.info('stats'), ['keyspace_hits', 'keyspace_misses', 'total_commands_processed']); } catch { /* ignore */ }
    return res.json({
      status: 'connected',
      hal_cache: hal,
      provider_health: { groq, cerebras, fireworks, anthropic, openai },
      redis: { memory, stats },
      last_updated: new Date().toISOString(),
    });
  } catch (e: any) {
    return res.json({ status: 'error', detail: e?.message ?? String(e) });
  }
});

export default router;
