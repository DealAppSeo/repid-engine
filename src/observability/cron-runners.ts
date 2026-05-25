/**
 * cron-runners.ts — canonical telemetry capture logic (CC1, 2026-05-25).
 *
 * Shared by the CLI scripts (scripts/observability/*, scripts/audit-probe/*) AND the
 * UptimeRobot cron trigger endpoints (src/routes/v1/internal-cron.ts). Keeping the
 * logic here (in src/) means every runtime import is src→src — no src→scripts import
 * (which would break the dist build path). Each runner takes a Supabase client so the
 * route passes the app's `db` and the scripts pass their own client.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const MOCK_TX_RE = /^0x(mock|abc|0{8})/i;
const since = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

type RunOpts = { persist?: boolean };

async function safeCount(sb: SupabaseClient, table: string, build: (q: any) => any): Promise<number | null> {
  try { const { count, error } = await build(sb.from(table).select('*', { count: 'exact', head: true })); return error ? null : (count ?? 0); }
  catch { return null; }
}

/** Point-in-time telemetry across operational/economic/hal/audit_trail families. */
export async function captureTelemetry(sb: SupabaseClient, opts: RunOpts = {}) {
  const metrics: Array<{ metric_family: string; metric_name: string; metric_value: any; metadata?: any }> = [];
  const add = async (family: string, name: string, fn: () => Promise<any>, metadata: any = {}) => {
    try { metrics.push({ metric_family: family, metric_name: name, metric_value: await fn(), metadata }); }
    catch (e: any) { metrics.push({ metric_family: family, metric_name: name, metric_value: { error: e.message }, metadata: { failed: true } }); }
  };

  await add('operational', 'active_agents_by_tier', async () => {
    const { data, error } = await sb.from('repid_agents').select('tier,lifecycle_status'); if (error) throw new Error(error.message);
    const byTier: Record<string, number> = {}; let active = 0;
    (data || []).forEach((a: any) => { if (a.lifecycle_status === 'active') { active++; byTier[a.tier] = (byTier[a.tier] || 0) + 1; } });
    return { active_total: active, by_tier: byTier, agents_total: data?.length ?? 0 };
  });
  await add('operational', 'queue_depth', async () => ({
    pending_contracts: await safeCount(sb, 'service_contracts', q => q.eq('status', 'pending')),
    escrowed_contracts: await safeCount(sb, 'service_contracts', q => q.eq('status', 'escrowed')),
    pending_bridge_writes: await safeCount(sb, 'repid_events', q => q.eq('event_type', 'service_fulfilled_settled').is('processed_at', null)),
  }));
  await add('economic', 'real_contract_settlements', async () => {
    const { data, error } = await sb.from('x402_settlements').select('idempotency_key,tx_hash').eq('is_simulated', false).not('idempotency_key', 'is', null);
    if (error) throw new Error(error.message);
    return { count: data?.length ?? 0, with_tx_hash: (data || []).filter((r: any) => r.tx_hash).length };
  });
  await add('economic', 'onchain_attestations', async () => {
    const { data, error } = await sb.from('erc8004_reputation_writes').select('id,tx_hash'); if (error) throw new Error(error.message);
    const real = (data || []).filter((r: any) => r.tx_hash && !MOCK_TX_RE.test(r.tx_hash));
    return { total: data?.length ?? 0, real_onchain: real.length, max_id: Math.max(0, ...(data || []).map((r: any) => r.id)) };
  });
  await add('hal', 'veto_rate_recent', async () => {
    const { data, error } = await sb.from('repid_score_events').select('hal_decision').not('hal_decision', 'is', null).order('created_at', { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    const v = (data || []).filter((r: any) => r.hal_decision === 'vetoed').length;
    return { window: data?.length ?? 0, vetoed: v, veto_rate: data?.length ? +(v / data.length).toFixed(4) : null };
  });
  await add('audit_trail', 'settlements_missing_tx_hash', async () =>
    await safeCount(sb, 'x402_settlements', q => q.eq('is_simulated', false).not('idempotency_key', 'is', null).is('tx_hash', null)), { gap: 'A' });
  await add('audit_trail', 'sim_to_onchain_leaks', async () => {
    const { data, error } = await sb.from('repid_events').select('id,event_data').eq('event_type', 'service_fulfilled_settled'); if (error) throw new Error(error.message);
    const leaks = (data || []).filter((e: any) => { const s = e.event_data?.is_simulated; const t = e.event_data?.reputation_tx_hash; return (s === true || s === 'true') && t && !MOCK_TX_RE.test(t); });
    return { leaks: leaks.length, ids: leaks.map((e: any) => e.id) };
  }, { invariant: 'must_be_zero' });

  const snapshot_at = new Date().toISOString();
  let persisted = 0;
  if (opts.persist !== false) {
    const rows = metrics.map(m => ({ snapshot_at, ...m, metadata: m.metadata || {} }));
    const { error } = await sb.from('repid_telemetry_snapshots').insert(rows);
    if (!error) persisted = rows.length;
  }
  return { snapshot_at, captured: metrics.length, persisted, families: [...new Set(metrics.map(m => m.metric_family))] };
}

/** 24-hour consolidated health rollup → one health_24h row. */
export async function healthSummary24h(sb: SupabaseClient, opts: RunOpts = {}) {
  const s = since(24);
  const settlements_total = await safeCount(sb, 'x402_settlements', q => q.gte('created_at', s));
  const settlements_real = await safeCount(sb, 'x402_settlements', q => q.gte('created_at', s).eq('is_simulated', false));
  let attestations = 0;
  try { const { data } = await sb.from('erc8004_reputation_writes').select('tx_hash').gte('created_at', s); attestations = (data || []).filter((r: any) => r.tx_hash && !MOCK_TX_RE.test(r.tx_hash)).length; } catch {}
  let hal: any = { window: 0, vetoed: 0, veto_rate: null };
  try { const { data } = await sb.from('repid_score_events').select('hal_decision').gte('created_at', s).not('hal_decision', 'is', null); const w = data?.length ?? 0; const v = (data || []).filter((r: any) => r.hal_decision === 'vetoed').length; hal = { window: w, vetoed: v, veto_rate: w ? +(v / w).toFixed(4) : null }; } catch {}
  const task_claims = await safeCount(sb, 'trinity_tasks', q => q.gte('claimed_at', s));
  const tasks_completed = await safeCount(sb, 'trinity_tasks', q => q.gte('completed_at', s));
  const score_events = await safeCount(sb, 'repid_score_events', q => q.gte('created_at', s));
  let active_agents: number | null = null;
  try { const { data } = await sb.from('repid_agents').select('lifecycle_status'); active_agents = (data || []).filter((a: any) => a.lifecycle_status === 'active').length; } catch {}

  const summary = { window: '24h', computed_at: new Date().toISOString(), settlements: { total: settlements_total, real: settlements_real }, onchain_attestations: attestations, hal_veto: hal, agent_task_claims: task_claims, tasks_completed, score_events, active_agents };
  let persisted = false;
  if (opts.persist !== false) {
    const { error } = await sb.from('repid_telemetry_snapshots').insert({ metric_family: 'health_24h', metric_name: 'daily_rollup', metric_value: summary, metadata: { window_hours: 24 } });
    persisted = !error;
  }
  return { ...summary, persisted };
}

/** Audit-trail integrity probe (subset of the standalone probe's checks) → one audit_probe row. */
export async function runAuditProbe(sb: SupabaseClient, opts: RunOpts = {}) {
  const s = since(24);
  type R = { check: string; status: 'PASS' | 'WARN' | 'FAIL'; detail: any };
  const results: R[] = [];
  const check = async (name: string, fn: () => Promise<{ status: R['status']; detail: any }>) => { try { results.push({ check: name, ...(await fn()) }); } catch (e: any) { results.push({ check: name, status: 'FAIL', detail: { error: e.message } }); } };

  await check('settlement_tx_hash_persisted', async () => {
    const { data, error } = await sb.from('x402_settlements').select('id').eq('is_simulated', false).not('idempotency_key', 'is', null).is('tx_hash', null).gte('created_at', s);
    if (error) throw new Error(error.message);
    return { status: (data && data.length) ? 'FAIL' : 'PASS', detail: { missing: data?.length ?? 0 } };
  });
  await check('no_duplicate_real_settlement', async () => {
    const { data, error } = await sb.from('x402_settlements').select('idempotency_key').eq('is_simulated', false).not('idempotency_key', 'is', null);
    if (error) throw new Error(error.message);
    const seen: Record<string, number> = {}; (data || []).forEach((r: any) => seen[r.idempotency_key] = (seen[r.idempotency_key] || 0) + 1);
    const dups = Object.entries(seen).filter(([, n]) => n > 1);
    return { status: dups.length ? 'FAIL' : 'PASS', detail: { duplicates: dups.length } };
  });
  await check('no_sim_to_onchain_leak', async () => {
    const { data, error } = await sb.from('repid_events').select('event_data').eq('event_type', 'service_fulfilled_settled'); if (error) throw new Error(error.message);
    const leaks = (data || []).filter((e: any) => { const sim = e.event_data?.is_simulated; const t = e.event_data?.reputation_tx_hash; return (sim === true || sim === 'true') && t && !MOCK_TX_RE.test(t); });
    return { status: leaks.length ? 'FAIL' : 'PASS', detail: { leaks: leaks.length } };
  });

  const fails = results.filter(r => r.status === 'FAIL').length;
  const warns = results.filter(r => r.status === 'WARN').length;
  const overall = fails ? 'FAIL' : warns ? 'WARN' : 'PASS';
  const computed_at = new Date().toISOString();
  let persisted = false;
  if (opts.persist !== false) {
    const { error } = await sb.from('repid_telemetry_snapshots').insert({ metric_family: 'audit_probe', metric_name: 'integrity_run', metric_value: { overall, results }, metadata: { window_hours: 24 } });
    persisted = !error;
  }
  return { overall, computed_at, results, persisted };
}
