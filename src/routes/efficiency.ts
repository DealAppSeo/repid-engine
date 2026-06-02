/**
 * S-OPTIMIZE — system efficiency dashboard. GET /api/v1/system/efficiency
 *
 * Real-time efficiency from live tables: waste (shadow_reject rate from trinity_tasks), cost +
 * throughput (llm_call_log), and learning (task_escalations resolution rate). Each metric is
 * computed defensively (returns null if its source is unavailable) so one missing surface doesn't
 * break the endpoint. Public read; 60s cache.
 *
 * NOTE (honest): cache_hit_rate is null — response caching is a design-only item (see
 * docs/OPTIMIZATION_PLAN.md), not yet implemented, so we don't fabricate a number.
 */
import { Router, Request, Response } from 'express';
import { db } from '../db';
import { isFreeProvider } from '../billing/free-providers';
import { fetchLlmCalls24h } from '../billing/llm-calls-24h';

const router = Router();
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const since24h = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString();

async function count(table: string, build: (q: any) => any): Promise<number | null> {
  try {
    const { count, error } = await build(db.from(table).select('*', { count: 'exact', head: true }));
    return error ? null : (count ?? 0);
  } catch { return null; }
}

async function wasteRate() {
  const since = since24h();
  const [shadow, done, failed, esc, escResolved] = await Promise.all([
    count('trinity_tasks', (q) => q.eq('status', 'shadow_reject').gte('updated_at', since)),
    count('trinity_tasks', (q) => q.eq('status', 'done').gte('updated_at', since)),
    count('trinity_tasks', (q) => q.eq('status', 'failed').gte('updated_at', since)),
    count('task_escalations', (q) => q.gte('created_at', since)),
    count('task_escalations', (q) => q.eq('resolution_status', 'resolved').gte('created_at', since)),
  ]);
  const resolved = (done ?? 0) + (shadow ?? 0) + (failed ?? 0);
  return {
    shadow_reject_pct: resolved ? r2(((shadow ?? 0) / resolved) * 100) : null,
    shadow_rejects_24h: shadow,
    tasks_done_24h: done,
    escalation_rate_pct: (done ?? 0) ? r2(((esc ?? 0) / (done ?? 1)) * 100) : null,
    escalations_24h: esc,
    escalations_resolved_24h: escResolved,
  };
}

async function llmMetrics() {
  try {
    const { rows } = await fetchLlmCalls24h<any>('provider, cost_usd, latency_ms, agent_id, status');
    let cost = 0, latSum = 0, latN = 0, free = 0;
    const agents = new Set<string>();
    for (const r of rows) {
      cost += num(r.cost_usd);
      if (num(r.latency_ms) > 0) { latSum += num(r.latency_ms); latN++; }
      if (isFreeProvider(r.provider)) free++;
      if (r.agent_id) agents.add(r.agent_id);
    }
    return {
      total_calls_24h: rows.length,
      total_cost_24h_usd: r4(cost),
      free_tier_pct: rows.length ? r2((free / rows.length) * 100) : null,
      avg_latency_ms: latN ? Math.round(latSum / latN) : null,
      active_agents_24h: agents.size,
    };
  } catch { return null; }
}

let cache: { at: number; payload: any } | null = null;
const CACHE_TTL_MS = 60 * 1000;

router.get('/system/efficiency', async (_req: Request, res: Response) => {
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return res.json(cache.payload);
    const [waste, llm] = await Promise.all([wasteRate(), llmMetrics()]);
    const tasksPerHour = waste.tasks_done_24h != null ? Math.round((waste.tasks_done_24h / 24)) : null;
    const learnRate = (waste.escalations_24h ?? 0) > 0
      ? r2((waste.escalations_resolved_24h ?? 0) / (waste.escalations_24h ?? 1)) : null;

    const payload = {
      waste_rate: {
        shadow_reject_pct: waste.shadow_reject_pct,
        escalation_rate_pct: waste.escalation_rate_pct,
        duplicate_task_pct: null, // requires description_hash (design-only — see OPTIMIZATION_PLAN.md)
      },
      cost: {
        total_24h_usd: llm?.total_cost_24h_usd ?? null,
        free_tier_pct: llm?.free_tier_pct ?? null,
        avg_cost_per_task_usd: (llm && waste.tasks_done_24h)
          ? r4(llm.total_cost_24h_usd / waste.tasks_done_24h) : null,
      },
      throughput: {
        tasks_per_hour: tasksPerHour,
        avg_latency_ms: llm?.avg_latency_ms ?? null,
        active_agents: llm?.active_agents_24h ?? null,
      },
      learning: {
        escalations_24h: waste.escalations_24h,
        escalation_learn_rate: learnRate,
        cache_hit_rate: null, // response cache not yet implemented (design-only)
      },
      counts: { shadow_rejects_24h: waste.shadow_rejects_24h, llm_calls_24h: llm?.total_calls_24h ?? null },
      last_updated: new Date().toISOString(),
    };
    cache = { at: Date.now(), payload };
    return res.json(payload);
  } catch (e: any) {
    return res.status(500).json({ error: 'efficiency_failed', detail: e?.message ?? String(e) });
  }
});

export function __clearEfficiencyCache() { cache = null; }
export default router;
