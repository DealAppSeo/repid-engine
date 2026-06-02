/**
 * S-OPTIMIZE — cost dashboard. GET /api/v1/costs/summary
 *
 * Surfaces the EXISTING per-call cost ledger (`llm_call_log`, written by src/billing/log-call.ts).
 * 24h totals, free-vs-paid split, savings from free-tier routing, and top spenders by agent /
 * provider / task. Aggregated in-process behind a 60s cache (the ledger is large; the dashboard
 * doesn't need to re-scan per request). Public read (mounted pre-auth alongside the other dashboards).
 */
import { Router, Request, Response } from 'express';
import { isFreeProvider, frontierCostEstimate } from '../billing/free-providers';
import { fetchLlmCalls24h } from '../billing/llm-calls-24h';

const router = Router();

interface CallRow {
  provider: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  agent_id: string | null;
  task_hint: string | null;
  status: string | null;
}

const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface CostSummary { [k: string]: any }

/** Pure aggregation — exported for unit tests. */
export function summarize(rows: CallRow[]): CostSummary {
  let total_tokens = 0, total_cost = 0, free_calls = 0, paid_calls = 0, would_have_cost = 0, free_actual_cost = 0;
  const byProvider = new Map<string, { calls: number; tokens: number; cost: number }>();
  const byAgent = new Map<string, { calls: number; cost: number }>();
  const byTask = new Map<string, { calls: number; cost: number }>();

  for (const r of rows) {
    const tokens = num(r.total_tokens) || num(r.prompt_tokens) + num(r.completion_tokens);
    const cost = num(r.cost_usd);
    total_tokens += tokens; total_cost += cost;
    const free = isFreeProvider(r.provider);
    if (free) { free_calls++; free_actual_cost += cost; would_have_cost += frontierCostEstimate(num(r.prompt_tokens), num(r.completion_tokens)); }
    else paid_calls++;

    const pk = r.provider ?? 'unknown';
    const p = byProvider.get(pk) ?? { calls: 0, tokens: 0, cost: 0 };
    p.calls++; p.tokens += tokens; p.cost += cost; byProvider.set(pk, p);

    const ak = r.agent_id ?? 'unattributed';
    const a = byAgent.get(ak) ?? { calls: 0, cost: 0 };
    a.calls++; a.cost += cost; byAgent.set(ak, a);

    const tk = r.task_hint ?? 'untagged';
    const t = byTask.get(tk) ?? { calls: 0, cost: 0 };
    t.calls++; t.cost += cost; byTask.set(tk, t);
  }

  const top_spenders = [...byAgent.entries()]
    .map(([agent, v]) => ({ agent, calls: v.calls, cost: r4(v.cost) }))
    .sort((a, b) => b.cost - a.cost || b.calls - a.calls).slice(0, 10);

  return {
    last_24h: {
      total_calls: rows.length,
      total_tokens,
      total_cost_usd: r4(total_cost),
      free_tier_calls: free_calls,
      paid_tier_calls: paid_calls,
      free_tier_pct: rows.length ? r2((free_calls / rows.length) * 100) : 0,
      cost_saved_by_free_usd: r4(Math.max(0, would_have_cost - free_actual_cost)),
      avg_cost_per_call_usd: rows.length ? r4(total_cost / rows.length) : 0,
      top_spenders,
    },
    by_provider: Object.fromEntries([...byProvider.entries()]
      .map(([k, v]) => [k, { calls: v.calls, tokens: v.tokens, cost_usd: r4(v.cost), free: isFreeProvider(k) }])
      .sort((a: any, b: any) => b[1].calls - a[1].calls)),
    by_task_type: Object.fromEntries([...byTask.entries()]
      .map(([k, v]) => [k, { calls: v.calls, cost_usd: r4(v.cost) }])
      .sort((a: any, b: any) => b[1].calls - a[1].calls)),
  };
}

let cache: { at: number; payload: any } | null = null;
const CACHE_TTL_MS = 60 * 1000;

router.get('/costs/summary', async (_req: Request, res: Response) => {
  try {
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) return res.json(cache.payload);
    const { rows, capped } = await fetchLlmCalls24h<CallRow>(
      'provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, agent_id, task_hint, status');
    const payload = {
      ...summarize(rows),
      window: '24h',
      capped,
      last_updated: new Date().toISOString(),
    };
    cache = { at: Date.now(), payload };
    return res.json(payload);
  } catch (e: any) {
    return res.status(500).json({ error: 'costs_failed', detail: e?.message ?? String(e) });
  }
});

export function __clearCostCache() { cache = null; }
export default router;
