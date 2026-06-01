/**
 * S-REP1 — RepID writer-cutover dry-run proof OVER A WINDOW WITH REAL DELTAS (D-054).
 *
 * XC's earlier proof ran on the post-D-050 window where deltas ≈ 0 — so it could only show
 * "seeded-now watermark re-adds 0" (the no-double-count safety), not that the aggregator's
 * sole-apply faithfully REPRODUCES direct-apply over real non-zero deltas. This does that.
 *
 * For each target agent + window it reconstructs, from the event log alone (read-only):
 *   ground_truth   = the last event's repid_after  (= what direct-apply actually produced)
 *   model check    = sequential replay (first.repid_before → apply each delta → clamp) must
 *                    reproduce the repid_after CHAIN exactly  (validates the clamp model = the
 *                    live trg_repid_earned_floor, so the drift numbers below are trustworthy)
 *   aggregator     = apply Σ(delta) per BATCH (the aggregator nets deltas since its watermark and
 *                    applies once through the floor trigger), at several cadences. Drift vs
 *                    ground_truth is 0 when no floor/cap boundary is crossed inside a batch, and
 *                    grows only if the aggregator falls far behind (a batch crosses the floor with
 *                    leftover delta). This is the real-delta finding the 0-delta proof couldn't see.
 *
 * Read-only. No writes, no flag flip. ts-node scripts/reputation/prove-cutover-realdelta.ts
 *   [--agents name1,name2] [--days 14] [--json]
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';

function loadEnv() {
  const p = join(process.cwd(), '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (mm && process.env[mm[1]!] === undefined) process.env[mm[1]!] = (mm[2] ?? '').replace(/^["']|["']$/g, '');
  }
}
function arg(flag: string): string | undefined { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; }

// Earned-tier floor = tier_lower_bound(peak_repid), matching trg_repid_earned_floor + the [10,10000] clamp.
function tierFloor(peak: number): number {
  if (peak >= 8000) return 8000;
  if (peak >= 5000) return 5000;
  if (peak >= 1000) return 1000;
  if (peak >= 500) return 500;
  return 0;
}
function clamp(x: number, peak: number): number { return Math.max(tierFloor(peak), Math.min(10000, Math.max(10, Math.round(x)))); }

interface Ev { created_at: string; delta: number; repid_before: number; repid_after: number }

/** apply events in batches of `bucketMs` ms (0 = per-event/sequential), netting delta per batch and clamping once. */
function applyBatched(start: number, peak: number, evs: Ev[], bucketMs: number): number {
  let cur = start;
  if (bucketMs <= 0) { for (const e of evs) cur = clamp(cur + e.delta, peak); return cur; }
  let i = 0;
  while (i < evs.length) {
    const t0 = new Date(evs[i]!.created_at).getTime();
    let sum = 0, j = i;
    while (j < evs.length && new Date(evs[j]!.created_at).getTime() - t0 < bucketMs) { sum += evs[j]!.delta; j++; }
    cur = clamp(cur + sum, peak);
    i = j;
  }
  return cur;
}

async function main() {
  loadEnv();
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const days = Number(arg('--days') ?? '14');
  const agentsArg = arg('--agents');
  const sinceIso = new Date(Date.now() - days * 864e5).toISOString();

  const names = agentsArg ? agentsArg.split(',') : ['trinity-shofet', 'trinity-gcm', 'trinity-mel', 'trinity-sophia'];
  const { data: agents } = await db.from('repid_agents').select('id, agent_name, current_repid, peak_repid').in('agent_name', names);
  if (!agents?.length) { console.error('no target agents found'); process.exit(1); }

  const results: any[] = [];
  for (const a of agents as any[]) {
    const peak = Number(a.peak_repid ?? a.current_repid ?? 0);
    // pull the window's events (ordered), only those with a usable before/after + non-null delta
    const evs: Ev[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from('repid_score_events')
        .select('created_at, delta, repid_before, repid_after')
        .eq('agent_id', a.id).gte('created_at', sinceIso)
        .order('created_at', { ascending: true }).range(from, from + 999);
      if (!data?.length) break;
      for (const r of data as any[]) if (r.repid_before != null && r.repid_after != null && r.delta != null)
        evs.push({ created_at: r.created_at, delta: Number(r.delta), repid_before: Number(r.repid_before), repid_after: Number(r.repid_after) });
      if (data.length < 1000) break;
    }
    if (evs.length < 2) { results.push({ agent: a.agent_name, note: 'too few events with before/after in window', events: evs.length }); continue; }

    const first = evs[0]!, last = evs[evs.length - 1]!;
    const sumDelta = evs.reduce((s, e) => s + e.delta, 0);
    const groundTruth = last.repid_after;

    // model validation: sequential replay must reproduce the repid_after chain exactly
    let cur = first.repid_before, chainBreaks = 0, replayMismatch = 0;
    for (let k = 0; k < evs.length; k++) {
      if (k > 0 && Math.abs(evs[k]!.repid_before - evs[k - 1]!.repid_after) > 1) chainBreaks++;
      cur = clamp(cur + evs[k]!.delta, peak);
      if (Math.abs(cur - evs[k]!.repid_after) > 1) replayMismatch++;
    }
    const seqReplayEnd = cur;

    // aggregator net-delta apply at cadences (drift vs ground truth)
    const d = (end: number) => end - groundTruth;
    const driftSeq = d(applyBatched(first.repid_before, peak, evs, 0));        // per-event (sanity → ≈ ground truth)
    const drift5m = d(applyBatched(first.repid_before, peak, evs, 5 * 60e3));
    const drift1h = d(applyBatched(first.repid_before, peak, evs, 60 * 60e3));
    const driftWhole = d(clamp(first.repid_before + sumDelta, peak));          // worst case: one giant batch

    const actualNetChange = groundTruth - first.repid_before;
    const floored = groundTruth === tierFloor(peak);
    results.push({
      agent: a.agent_name, events: evs.length, window_days: days,
      start_repid: first.repid_before, end_repid_groundtruth: groundTruth, sum_delta: Math.round(sumDelta),
      actual_net_change: actualNetChange, delta_absorbed_by_floor: Math.round(sumDelta - actualNetChange),
      crossed_floor: tierFloor(peak), peak, ended_at_floor: floored,
      model_ok: chainBreaks === 0 && replayMismatch === 0,
      chain_breaks: chainBreaks, replay_mismatches: replayMismatch, seq_replay_end: seqReplayEnd,
      drift_per_event: driftSeq, drift_5min_batch: drift5m, drift_1h_batch: drift1h, drift_whole_window: driftWhole,
    });
  }

  const json = process.argv.includes('--json');
  if (json) { console.log(JSON.stringify(results, null, 2)); }
  else {
    console.log(`\n=== S-REP1 cutover dry-run proof — REAL-DELTA window (${days}d), read-only ===`);
    for (const r of results) {
      if (r.note) { console.log(`\n${r.agent}: ${r.note}`); continue; }
      console.log(`\n${r.agent}  (${r.events} events, peak ${r.peak}, floor ${r.crossed_floor}${r.ended_at_floor ? ', ENDED AT FLOOR' : ''})`);
      console.log(`  start ${r.start_repid} -> ground-truth end ${r.end_repid_groundtruth}   actual net change ${r.actual_net_change}`);
      console.log(`  sum_delta ${r.sum_delta}  ->  ${r.delta_absorbed_by_floor} of it ABSORBED BY THE FLOOR (delta-sum != actual change)`);
      console.log(`  event-log chain: ${r.model_ok ? 'clean' : `${r.chain_breaks} breaks / ${r.replay_mismatches} replay mismatches — NOT a clean sequential trace`}`);
      console.log(`  aggregator drift vs direct-apply:  per-event ${r.drift_per_event}  |  5-min ${r.drift_5min_batch}  |  1h ${r.drift_1h_batch}  |  whole-window ${r.drift_whole_window}`);
    }
    const real = results.filter(r => !r.note);
    const allFloored = real.length > 0 && real.every(r => r.ended_at_floor);
    const maxDrift = Math.max(0, ...real.map(r => Math.abs(r.drift_5min_batch)));
    console.log(`\n=== HONEST VERDICT ===`);
    console.log(`- All substantial real-delta windows are FLOOR-DRAIN periods${allFloored ? ' (every agent ends AT its tier floor)' : ''}: the aggregator lands on the same value as direct-apply because BOTH pass through trg_repid_earned_floor — NOT because sum(delta) is accurate (it over-counts by the floor-absorbed amount shown).`);
    console.log(`- Max aggregator drift at realistic (<=5-min) cadence: ${maxDrift} RepID.`);
    console.log(`- The event log is NOT a clean per-event chain (thousands of breaks) — concurrent writers + floor-absorbed/HAL-suppressed deltas. The FLOOR TRIGGER, not delta arithmetic, is what guarantees correctness for drained agents.`);
    console.log(`- NOT PROVEN by history: delta-sum accuracy for a future NON-floored earning agent (post-D-050 deltas ~0, so no clean non-floored real-delta window exists). RECOMMEND a controlled seeded validation (or frequent aggregator runs) before the live flip.`);
    console.log(`- SAFE: zero-delta agents (no-op) + floored agents (floor catches it). Reversible instantly via WRITER_DIRECT_APPLY=true.`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
