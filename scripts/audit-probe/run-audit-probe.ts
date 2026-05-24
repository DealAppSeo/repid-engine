/**
 * run-audit-probe.ts — daily audit-trail integrity prober (CC1, 2026-05-25).
 *
 * Verifies the cross-table audit trail stays intact as the economy runs. Catches
 * future drift of the gaps fixed in the 05-24 cycle (esp. settlement tx_hash) and
 * the launch invariants (no simulated→on-chain leak, no duplicate real fire).
 *
 *   ts-node scripts/audit-probe/run-audit-probe.ts --report-only      # print, no write
 *   ts-node scripts/audit-probe/run-audit-probe.ts                    # + telemetry snapshot
 *   ts-node scripts/audit-probe/run-audit-probe.ts --window-hours=48
 *
 * Read-only against all source tables. NEVER auto-fixes — surfaces for Sean review.
 * Drift checks are scoped to a recent window (default 24h) so historical pre-fix debt
 * is not re-flagged; INVARIANT checks are all-time (must always hold).
 * Exit code 0 = all PASS/WARN; 1 = any FAIL (so it can gate a scheduled alert).
 */
import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const sb = createClient(
  process.env.SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY) as string,
);

const argv = process.argv.slice(2);
const REPORT_ONLY = argv.includes('--report-only');
const WINDOW_H = Number(argv.find(a => a.startsWith('--window-hours='))?.split('=')[1] || 24);
const sinceISO = new Date(Date.now() - WINDOW_H * 3600 * 1000).toISOString();
const MOCK_TX_RE = /^0x(mock|abc|0{8})/i;

type Status = 'PASS' | 'WARN' | 'FAIL';
interface CheckResult { check: string; status: Status; detail: any; scope: string; }
const results: CheckResult[] = [];
async function check(name: string, scope: string, fn: () => Promise<{ status: Status; detail: any }>) {
  try { const r = await fn(); results.push({ check: name, scope, ...r }); }
  catch (e: any) { results.push({ check: name, scope, status: 'FAIL', detail: { error: e.message } }); }
}

(async () => {
  // 1. INVARIANT — real settlement must persist tx_hash (regression of the 05-24 tx_hash fix).
  //    Scoped to recent window so the historical pre-fix backlog isn't re-flagged.
  await check('settlement_tx_hash_persisted', `last ${WINDOW_H}h`, async () => {
    const { data, error } = await sb.from('x402_settlements')
      .select('id,idempotency_key,created_at')
      .eq('is_simulated', false).not('idempotency_key', 'is', null).is('tx_hash', null)
      .gte('created_at', sinceISO);
    if (error) throw new Error(error.message);
    return { status: (data && data.length) ? 'FAIL' : 'PASS', detail: { missing: data?.length ?? 0, ids: (data || []).map((r: any) => r.id) } };
  });

  // 2. INVARIANT — no duplicate real settlement per contract (double-fulfill / replay). All-time.
  await check('no_duplicate_real_settlement', 'all-time', async () => {
    const { data, error } = await sb.from('x402_settlements').select('idempotency_key')
      .eq('is_simulated', false).not('idempotency_key', 'is', null);
    if (error) throw new Error(error.message);
    const seen: Record<string, number> = {}; (data || []).forEach((r: any) => seen[r.idempotency_key] = (seen[r.idempotency_key] || 0) + 1);
    const dups = Object.entries(seen).filter(([, n]) => n > 1);
    return { status: dups.length ? 'FAIL' : 'PASS', detail: { duplicates: dups } };
  });

  // 3. INVARIANT — no simulated→on-chain leak (a sim fulfillment must never carry a real attestation). All-time.
  await check('no_sim_to_onchain_leak', 'all-time', async () => {
    const { data, error } = await sb.from('repid_events').select('id,event_data').eq('event_type', 'service_fulfilled_settled');
    if (error) throw new Error(error.message);
    const leaks = (data || []).filter((e: any) => {
      const sim = e.event_data?.is_simulated; const t = e.event_data?.reputation_tx_hash;
      return (sim === true || sim === 'true') && t && !MOCK_TX_RE.test(t);
    });
    return { status: leaks.length ? 'FAIL' : 'PASS', detail: { leaks: leaks.length, ids: leaks.map((e: any) => e.id) } };
  });

  // 4. DRIFT — on-chain writes linkable to a triggering event (via reputation_tx_hash echo). Recent.
  await check('onchain_writes_linkable', `last ${WINDOW_H}h`, async () => {
    const { data, error } = await sb.from('erc8004_reputation_writes').select('id,tx_hash,created_at').gte('created_at', sinceISO);
    if (error) throw new Error(error.message);
    const real = (data || []).filter((r: any) => r.tx_hash && !MOCK_TX_RE.test(r.tx_hash));
    let unlinked: number[] = [];
    for (const r of real) {
      const { data: ev } = await sb.from('repid_events').select('id').eq('event_data->>reputation_tx_hash', r.tx_hash).limit(1);
      if (!ev || !ev.length) unlinked.push(r.id);
    }
    // WARN not FAIL: admin/backfill writes are legitimately unlinked.
    return { status: unlinked.length ? 'WARN' : 'PASS', detail: { real_writes: real.length, unlinked } };
  });

  // 5. DRIFT — orphan real settlements (idempotency_key set but no matching contract). Recent.
  await check('no_orphan_settlements', `last ${WINDOW_H}h`, async () => {
    const { data, error } = await sb.from('x402_settlements').select('id,idempotency_key')
      .eq('is_simulated', false).not('idempotency_key', 'is', null).gte('created_at', sinceISO);
    if (error) throw new Error(error.message);
    let orphans: string[] = [];
    for (const r of (data || [])) {
      const { data: c } = await sb.from('service_contracts').select('id').eq('id', r.idempotency_key).maybeSingle();
      if (!c) orphans.push(r.id);
    }
    return { status: orphans.length ? 'WARN' : 'PASS', detail: { orphans } };
  });

  // 6. DRIFT — fulfilled contracts have a settlement record. Recent.
  await check('fulfilled_has_settlement', `last ${WINDOW_H}h`, async () => {
    const { data, error } = await sb.from('service_contracts').select('id,x402_payment_id').eq('status', 'fulfilled').gte('fulfilled_at', sinceISO);
    if (error) throw new Error(error.message);
    const missing = (data || []).filter((c: any) => !c.x402_payment_id).map((c: any) => c.id);
    return { status: missing.length ? 'WARN' : 'PASS', detail: { fulfilled: data?.length ?? 0, missing_settlement: missing } };
  });

  // ── REPORT ──────────────────────────────────────────────────
  const computed_at = new Date().toISOString();
  const fails = results.filter(r => r.status === 'FAIL');
  const warns = results.filter(r => r.status === 'WARN');
  const overall: Status = fails.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS';
  console.log(`\n=== AUDIT-TRAIL INTEGRITY PROBE @ ${computed_at} (window ${WINDOW_H}h) → ${overall} ===`);
  for (const r of results) console.log(`  [${r.status}] ${r.check} (${r.scope}): ${JSON.stringify(r.detail)}`);
  console.log(`  summary: ${results.filter(r => r.status === 'PASS').length} PASS / ${warns.length} WARN / ${fails.length} FAIL`);

  if (!REPORT_ONLY) {
    try {
      const { error } = await sb.from('repid_telemetry_snapshots').insert({
        snapshot_at: computed_at, metric_family: 'audit_probe', metric_name: 'integrity_run',
        metric_value: { overall, results }, metadata: { window_hours: WINDOW_H },
      });
      console.log(error ? `\n⚠️ telemetry not written (${error.message}); apply migration 001 to persist.` : `\n✅ probe result persisted to repid_telemetry_snapshots.`);
    } catch (e: any) { console.log(`\n⚠️ telemetry not written (${e.message}).`); }
  }
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('audit-probe crashed:', e.message); process.exit(1); });
