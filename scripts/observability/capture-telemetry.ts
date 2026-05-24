/**
 * capture-telemetry.ts — point-in-time telemetry snapshot for the RepID economic loop.
 * CC1, 2026-05-24 (mainnet-readiness sprint). Pull-pattern: queries prod, persists snapshots.
 *
 *   ts-node scripts/observability/capture-telemetry.ts --family all
 *   ts-node scripts/observability/capture-telemetry.ts --family economic --dry-run
 *
 * Families: operational | economic | hal | audit_trail | all (default).
 * Table-optional: if `repid_telemetry_snapshots` is absent (migration not yet applied) OR
 * --dry-run is passed, it prints JSON and writes nothing. Every metric is isolated in
 * try/catch so one failure never aborts the run. Read-only against all source tables.
 *
 * Adapts (does not duplicate) existing infra: leverages the `trinity_swarm_health` view and
 * the same source tables as scripts/capture-baseline.ts; complementary to Gemini's in-memory
 * src/observability/x402-metrics.ts (this script can also poll that endpoint when present).
 */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const sb = createClient(
  process.env.SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY) as string,
);

const argv = process.argv.slice(2);
const familyArg = (argv.find(a => a.startsWith('--family'))?.split('=')[1])
  || (argv.includes('--family') ? argv[argv.indexOf('--family') + 1] : 'all');
const DRY = argv.includes('--dry-run');
const FAMILY = (familyArg || 'all').toLowerCase();

const MOCK_TX_RE = /^0x(mock|abc|0{8})/i;
const since = (h: number) => new Date(Date.now() - h * 3600 * 1000).toISOString();

type Metric = { metric_family: string; metric_name: string; metric_value: any; metadata?: any };
const metrics: Metric[] = [];
async function add(family: string, name: string, fn: () => Promise<any>, metadata: any = {}) {
  if (FAMILY !== 'all' && FAMILY !== family) return;
  try {
    const metric_value = await fn();
    metrics.push({ metric_family: family, metric_name: name, metric_value, metadata });
  } catch (e: any) {
    metrics.push({ metric_family: family, metric_name: name, metric_value: { error: e.message }, metadata: { failed: true } });
  }
}
const count = async (table: string, build: (q: any) => any = q => q): Promise<number> => {
  const { count, error } = await build(sb.from(table).select('*', { count: 'exact', head: true }));
  if (error) throw new Error(error.message);
  return count ?? 0;
};

(async () => {
  // ── OPERATIONAL ──────────────────────────────────────────────
  await add('operational', 'active_agents_by_tier', async () => {
    const { data, error } = await sb.from('repid_agents').select('tier,lifecycle_status');
    if (error) throw new Error(error.message);
    const byTier: Record<string, number> = {}; let active = 0;
    (data || []).forEach((a: any) => { if (a.lifecycle_status === 'active') { active++; byTier[a.tier] = (byTier[a.tier] || 0) + 1; } });
    return { active_total: active, by_tier: byTier, agents_total: data?.length ?? 0 };
  });
  await add('operational', 'queue_depth', async () => ({
    pending_contracts: await count('service_contracts', q => q.eq('status', 'pending')),
    escrowed_contracts: await count('service_contracts', q => q.eq('status', 'escrowed')),
    pending_bridge_writes: await count('repid_events', q => q.eq('event_type', 'service_fulfilled_settled').is('processed_at', null)),
  }));
  await add('operational', 'failed_settlements_24h', async () =>
    await count('x402_settlements', q => q.gte('created_at', since(24)).neq('status', 'settled')));
  await add('operational', 'swarm_health', async () => {
    const { data, error } = await sb.from('trinity_swarm_health').select('*');
    if (error) throw new Error(error.message);
    return { rows: data?.length ?? 0, sample: (data || []).slice(0, 3) };
  });

  // ── ECONOMIC ─────────────────────────────────────────────────
  await add('economic', 'real_contract_settlements', async () => {
    const { data, error } = await sb.from('x402_settlements').select('idempotency_key,tx_hash').eq('is_simulated', false).not('idempotency_key', 'is', null);
    if (error) throw new Error(error.message);
    return { count: data?.length ?? 0, with_tx_hash: (data || []).filter((r: any) => r.tx_hash).length };
  });
  await add('economic', 'onchain_attestations', async () => {
    const { data, error } = await sb.from('erc8004_reputation_writes').select('id,tx_hash');
    if (error) throw new Error(error.message);
    const real = (data || []).filter((r: any) => r.tx_hash && !MOCK_TX_RE.test(r.tx_hash));
    return { total: data?.length ?? 0, real_onchain: real.length, max_id: Math.max(0, ...(data || []).map((r: any) => r.id)) };
  });
  await add('economic', 'cumulative_repid_active', async () => {
    const { data, error } = await sb.from('repid_agents').select('current_repid,lifecycle_status');
    if (error) throw new Error(error.message);
    const active = (data || []).filter((a: any) => a.lifecycle_status === 'active');
    return { sum_repid_active: active.reduce((s: number, a: any) => s + (a.current_repid || 0), 0), active_n: active.length };
  });
  await add('economic', 'settlement_velocity_24h', async () =>
    await count('x402_settlements', q => q.gte('created_at', since(24)).eq('is_simulated', false)));

  // ── HAL ──────────────────────────────────────────────────────
  await add('hal', 'veto_rate_recent', async () => {
    const { data, error } = await sb.from('repid_score_events').select('hal_decision').not('hal_decision', 'is', null).order('created_at', { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    const vetoed = (data || []).filter((r: any) => r.hal_decision === 'vetoed').length;
    return { window: data?.length ?? 0, vetoed, veto_rate: data?.length ? +(vetoed / data.length).toFixed(4) : null };
  });
  await add('hal', 'hal_decision_distrib_7d', async () => {
    const { data, error } = await sb.from('repid_score_events').select('hal_decision').gte('created_at', since(24 * 7)).not('hal_decision', 'is', null);
    if (error) throw new Error(error.message);
    const d: Record<string, number> = {}; (data || []).forEach((r: any) => d[r.hal_decision] = (d[r.hal_decision] || 0) + 1);
    return d;
  });
  // degraded-quorum rate is NOT yet observable from score events (HAL provider_health/quorum not
  // bubbled into repid_score_events — known gap). Recorded as null with a note for honesty.
  await add('hal', 'degraded_quorum_rate', async () => ({ value: null, note: 'not observable: HAL provider_health/quorum not bubbled to repid_score_events (CC1 prior-sprint caveat)' }));

  // ── AUDIT_TRAIL (ongoing integrity monitors, from Phase 1) ───
  await add('audit_trail', 'settlements_missing_tx_hash', async () =>
    await count('x402_settlements', q => q.eq('is_simulated', false).not('idempotency_key', 'is', null).is('tx_hash', null)), { gap: 'A', remediated_when: 0 });
  await add('audit_trail', 'sim_to_onchain_leaks', async () => {
    // service_fulfilled_settled that are is_simulated yet have a reputation_tx_hash → must be 0
    const { data, error } = await sb.from('repid_events').select('id,event_data').eq('event_type', 'service_fulfilled_settled');
    if (error) throw new Error(error.message);
    const leaks = (data || []).filter((e: any) => {
      const sim = e.event_data?.is_simulated; const t = e.event_data?.reputation_tx_hash;
      return (sim === true || sim === 'true') && t && !MOCK_TX_RE.test(t);
    });
    return { leaks: leaks.length, ids: leaks.map((e: any) => e.id) };
  }, { invariant: 'must_be_zero' });
  await add('audit_trail', 'onchain_writes_unlinked', async () => {
    const { data, error } = await sb.from('erc8004_reputation_writes').select('id,tx_hash');
    if (error) throw new Error(error.message);
    const real = (data || []).filter((r: any) => r.tx_hash && !MOCK_TX_RE.test(r.tx_hash));
    let unlinked = 0;
    for (const r of real) {
      const { data: ev } = await sb.from('repid_events').select('id').eq('event_data->>reputation_tx_hash', r.tx_hash).limit(1);
      if (!ev || !ev.length) unlinked++;
    }
    return { real_writes: real.length, unlinked };
  });

  // ── EMIT / PERSIST ───────────────────────────────────────────
  const snapshot_at = new Date().toISOString();
  console.log(`\n=== telemetry snapshot @ ${snapshot_at} (family=${FAMILY}${DRY ? ', DRY-RUN' : ''}) ===`);
  for (const m of metrics) console.log(`[${m.metric_family}] ${m.metric_name}:`, JSON.stringify(m.metric_value));

  if (DRY) { console.log('\n(dry-run — nothing written)'); return; }
  // table-optional persistence — any failure (absent table / RLS / no message) falls back cleanly
  const rows = metrics.map(m => ({ snapshot_at, ...m, metadata: m.metadata || {} }));
  try {
    const probe = await sb.from('repid_telemetry_snapshots').select('id', { head: true, count: 'exact' });
    if (probe.error) throw probe.error;
    const { error: insErr } = await sb.from('repid_telemetry_snapshots').insert(rows);
    if (insErr) throw insErr;
    console.log(`\n✅ persisted ${rows.length} metric rows.`);
  } catch (e: any) {
    const why = e?.message || e?.code || e?.details || 'table absent or not writable';
    console.log(`\n⚠️ repid_telemetry_snapshots not writable yet (${why}). Apply scripts/observability/migrations/001_*.sql then re-run. Metrics above are the live baseline.`);
  }
})().catch(e => { console.error('capture-telemetry crashed:', e.message); process.exit(1); });
