/**
 * S-R5 Phase 2 — cost observability readout. llm_call_log is ALREADY populated for HAL fact-check
 * (task_hint='hal_fact_check', cost_usd via billing/pricing). This prints spend + calls + success
 * rate by provider over a window, and per-quorum cost (quorum_id). Run:
 *   WINDOW_HOURS=24 ts-node scripts/cost/spend-readout.ts
 */
import { db } from '../../src/db';

const HOURS = Number(process.env.WINDOW_HOURS ?? '24');

(async () => {
  const since = new Date(Date.now() - HOURS * 3600_000).toISOString();
  const { data, error } = await db
    .from('llm_call_log')
    .select('provider, status, cost_usd, total_tokens, latency_ms, quorum_id')
    .eq('task_hint', 'hal_fact_check')
    .gte('created_at', since)
    .limit(100000);
  if (error) { console.error('read failed:', error.message); process.exit(1); }
  const rows = (data ?? []) as any[];

  type Agg = { calls: number; ok: number; cost: number; tokens: number; latency: number };
  const byProvider = new Map<string, Agg>();
  const quorums = new Set<string>();
  let totalCost = 0, totalCalls = 0, okCalls = 0;
  for (const r of rows) {
    const a = byProvider.get(r.provider) ?? { calls: 0, ok: 0, cost: 0, tokens: 0, latency: 0 };
    a.calls++; if (r.status === 'success') { a.ok++; okCalls++; }
    a.cost += Number(r.cost_usd ?? 0); a.tokens += Number(r.total_tokens ?? 0); a.latency += Number(r.latency_ms ?? 0);
    byProvider.set(r.provider, a);
    totalCost += Number(r.cost_usd ?? 0); totalCalls++;
    if (r.quorum_id) quorums.add(r.quorum_id);
  }

  const pad = (s: any, n: number) => String(s).padEnd(n);
  console.log(`=== HAL fact-check spend — last ${HOURS}h (${totalCalls} calls, ${quorums.size || 'n/a'} quorums) ===`);
  console.log(pad('provider', 12) + pad('calls', 8) + pad('success%', 10) + pad('cost_usd', 12) + pad('avg_ms', 9) + pad('tokens', 9));
  for (const [p, a] of [...byProvider.entries()].sort((x, y) => y[1].cost - x[1].cost)) {
    console.log(pad(p, 12) + pad(a.calls, 8) + pad((100 * a.ok / a.calls).toFixed(1) + '%', 10) + pad('$' + a.cost.toFixed(5), 12) + pad(Math.round(a.latency / a.calls), 9) + pad(a.tokens, 9));
  }
  console.log(`\nTOTAL: $${totalCost.toFixed(5)} over ${totalCalls} calls (${(100 * okCalls / (totalCalls || 1)).toFixed(1)}% success); ` +
    `≈ $${quorums.size ? (totalCost / quorums.size).toFixed(6) : '—'}/quorum; projected 24h ≈ $${(totalCost * 24 / HOURS).toFixed(4)}.`);
  console.log(`SPEND_CEILING_USD guard: free-tier (groq/cerebras) cost $0; paid (deepseek) is the spend line above.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
