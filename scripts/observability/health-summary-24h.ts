/**
 * health-summary-24h.ts — daily 24-hour health rollup (CC1, 2026-05-25).
 *
 * Daily-cron candidate. Captures one consolidated row into repid_telemetry_snapshots
 * (metric_family='health_24h'): settlement counts, attestation count, HAL veto rate,
 * agent task claims, score events, active agents — the numbers Sean reviews each day.
 *
 *   ts-node scripts/observability/health-summary-24h.ts            # capture + persist
 *   ts-node scripts/observability/health-summary-24h.ts --dry-run  # print only
 *
 * Read-only against source tables; single additive write to the telemetry table.
 * Exit 0 always (a daily summary should not fail a cron on a transient read).
 */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const sb = createClient(
  process.env.SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY) as string,
);
const DRY = process.argv.includes('--dry-run');
const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
const MOCK_TX_RE = /^0x(mock|abc|0{8})/i;

async function count(table: string, build: (q: any) => any): Promise<number | null> {
  try { const { count, error } = await build(sb.from(table).select('*', { count: 'exact', head: true })); return error ? null : (count ?? 0); }
  catch { return null; }
}

(async () => {
  // settlements
  const settlements_total = await count('x402_settlements', q => q.gte('created_at', since));
  const settlements_real = await count('x402_settlements', q => q.gte('created_at', since).eq('is_simulated', false));
  // attestations (24h) — count real (non-mock) on-chain writes
  let attestations = 0;
  try {
    const { data } = await sb.from('erc8004_reputation_writes').select('tx_hash').gte('created_at', since);
    attestations = (data || []).filter((r: any) => r.tx_hash && !MOCK_TX_RE.test(r.tx_hash)).length;
  } catch { attestations = 0; }
  // HAL veto rate (24h)
  let hal: { window: number; vetoed: number; veto_rate: number | null } = { window: 0, vetoed: 0, veto_rate: null };
  try {
    const { data } = await sb.from('repid_score_events').select('hal_decision').gte('created_at', since).not('hal_decision', 'is', null);
    const w = data?.length ?? 0; const v = (data || []).filter((r: any) => r.hal_decision === 'vetoed').length;
    hal = { window: w, vetoed: v, veto_rate: w ? +(v / w).toFixed(4) : null };
  } catch { /* leave default */ }
  // agent task claims (24h)
  const task_claims = await count('trinity_tasks', q => q.gte('claimed_at', since));
  const tasks_completed = await count('trinity_tasks', q => q.gte('completed_at', since));
  // score events + active agents
  const score_events = await count('repid_score_events', q => q.gte('created_at', since));
  let active_agents: number | null = null;
  try { const { data } = await sb.from('repid_agents').select('lifecycle_status'); active_agents = (data || []).filter((a: any) => a.lifecycle_status === 'active').length; } catch {}

  const summary = {
    window: '24h', computed_at: new Date().toISOString(),
    settlements: { total: settlements_total, real: settlements_real },
    onchain_attestations: attestations,
    hal_veto: hal,
    agent_task_claims: task_claims,
    tasks_completed,
    score_events,
    active_agents,
  };
  console.log('=== 24h HEALTH SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));

  if (DRY) { console.log('\n(dry-run — not persisted)'); return; }
  try {
    const { error } = await sb.from('repid_telemetry_snapshots').insert({
      metric_family: 'health_24h', metric_name: 'daily_rollup', metric_value: summary, metadata: { window_hours: 24 },
    });
    console.log(error ? `\n⚠️ not persisted (${error.message}) — apply migration 001 if absent.` : '\n✅ persisted daily rollup to repid_telemetry_snapshots.');
  } catch (e: any) { console.log(`\n⚠️ not persisted (${e.message}).`); }
})().catch(e => { console.error('health-summary crashed:', e.message); process.exit(0); });
