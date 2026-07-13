/**
 * XC #24 — HAL shadow threshold autotune (dry-run by default).
 *
 * Measures catch / FP rates from hal_runner_results (excluding CONTAMINATED-*)
 * and optionally writes SHADOW keys only:
 *   - repid_config.hal_veto_threshold_shadow
 *   - repid_config.hal_block_threshold_shadow
 *   - hal_threshold_updates with update_type='shadow'
 *
 * NEVER writes hal_veto_threshold / hal_block_threshold (live).
 *
 * Usage:
 *   npx ts-node --transpile-only scripts/hal/shadow-threshold-autotune.ts
 *   npx ts-node --transpile-only scripts/hal/shadow-threshold-autotune.ts --write-shadow
 *
 * Write path also requires HAL_SHADOW_AUTOTUNE_WRITE=true (belt + suspenders).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const LIVE_VETO_KEYS = new Set(['hal_veto_threshold', 'hal_block_threshold']);
const SHADOW_VETO_KEY = 'hal_veto_threshold_shadow';
const SHADOW_BLOCK_KEY = 'hal_block_threshold_shadow';

const MIN_LABELED = 30;
const VETO_MIN = 0.25;
const VETO_MAX = 0.7;
const BLOCK_GAP = 0.05;

function env(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const url = env('SUPABASE_URL') || env('NEXT_PUBLIC_SUPABASE_URL');
  const key =
    env('SUPABASE_SERVICE_ROLE_KEY') ||
    env('SUPABASE_SERVICE_KEY') ||
    env('SUPABASE_SECRET_KEY');
  if (!url || !key) {
    console.error('[shadow-autotune] missing SUPABASE_URL / service role key');
    process.exit(2);
  }

  const writeRequested = argFlag('write-shadow');
  const writeEnabled =
    writeRequested && process.env.HAL_SHADOW_AUTOTUNE_WRITE === 'true';

  if (writeRequested && !writeEnabled) {
    console.warn(
      '[shadow-autotune] --write-shadow ignored: set HAL_SHADOW_AUTOTUNE_WRITE=true to allow shadow writes',
    );
  }

  const db = createClient(url, key, { auth: { persistSession: false } });

  // 1) Pull recent non-contaminated runner rows (cap for cost)
  const { data: runnerRows, error: runnerErr } = await db
    .from('hal_runner_results')
    .select(
      'id, created_at, benchmark_source, run_id, hal_score, hal_vetoed, hal_mode, ground_truth_is_hallucination, was_caught, false_positive, gen_failed',
    )
    .not('benchmark_source', 'ilike', 'CONTAMINATED%')
    .order('created_at', { ascending: false })
    .limit(2000);

  if (runnerErr) {
    console.error('[shadow-autotune] runner query failed:', runnerErr.message);
    process.exit(1);
  }

  const rows = (runnerRows ?? []).filter((r) => r.gen_failed !== true);
  const bySource: Record<string, number> = {};
  for (const r of rows) {
    const s = String(r.benchmark_source ?? 'unknown');
    bySource[s] = (bySource[s] ?? 0) + 1;
  }

  // 2) Labels (preferred ground truth)
  const ids = rows.map((r) => String(r.id));
  let labels: Array<{ source_id: string; is_hallucination: boolean; ground_truth_confidence: number | null }> = [];
  if (ids.length) {
    // PostgREST in() has URL limits — batch
    const batchSize = 100;
    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const { data, error } = await db
        .from('hal_ground_truth_labels')
        .select('source_id, is_hallucination, ground_truth_confidence')
        .eq('source_table', 'hal_runner_results')
        .in('source_id', chunk);
      if (error) {
        console.warn('[shadow-autotune] labels batch error:', error.message);
        break;
      }
      labels = labels.concat((data as typeof labels) ?? []);
    }
  }

  const labelById = new Map<string, boolean>();
  for (const l of labels) {
    if (l.ground_truth_confidence != null && Number(l.ground_truth_confidence) < 0.7) continue;
    labelById.set(String(l.source_id), !!l.is_hallucination);
  }

  // 3) Confusion on labeled subset (predicted = hal_vetoed)
  let tp = 0,
    fp = 0,
    tn = 0,
    fn = 0;
  let scored = 0;
  for (const r of rows) {
    const truth = labelById.get(String(r.id));
    if (truth === undefined) continue;
    if (r.hal_vetoed == null) continue;
    scored++;
    const pred = !!r.hal_vetoed;
    if (pred && truth) tp++;
    else if (pred && !truth) fp++;
    else if (!pred && !truth) tn++;
    else fn++;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const vetoRate =
    rows.filter((r) => r.hal_vetoed === true).length / Math.max(1, rows.filter((r) => r.hal_vetoed != null).length);

  // 4) Live config
  const { data: cfgRows } = await db
    .from('repid_config')
    .select('key, value')
    .in('key', [
      'hal_veto_threshold',
      'hal_block_threshold',
      SHADOW_VETO_KEY,
      SHADOW_BLOCK_KEY,
      'hal_shadow_autotune_enabled',
    ]);
  const cfg = Object.fromEntries((cfgRows ?? []).map((r: { key: string; value: string }) => [r.key, r.value]));

  const liveVeto = Number(cfg.hal_veto_threshold ?? 0.43);
  const liveBlock = Number(cfg.hal_block_threshold ?? 0.55);

  // 5) Propose shadow: simple F1-preserving nudge toward target veto rate ~0.15–0.35 on labeled set.
  //    If insufficient labels, DO NOT invent a new threshold — report only.
  let proposedVeto = liveVeto;
  let proposalReason = 'insufficient_labels_hold_live';
  if (scored >= MIN_LABELED) {
    // If precision low, raise veto bar; if recall low, lower bar. Bounded step ±0.03.
    let delta = 0;
    if (precision < 0.7 && fp > tp) delta += 0.03;
    if (recall < 0.7 && fn > 0) delta -= 0.03;
    if (Math.abs(delta) < 1e-9) {
      proposalReason = `hold_f1=${f1.toFixed(3)}_n=${scored}`;
    } else {
      proposedVeto = clamp(liveVeto + delta, VETO_MIN, VETO_MAX);
      proposalReason = `nudge_delta=${delta}_f1=${f1.toFixed(3)}_p=${precision.toFixed(3)}_r=${recall.toFixed(3)}_n=${scored}`;
    }
  }
  const proposedBlock = clamp(Math.max(proposedVeto + BLOCK_GAP, liveBlock), proposedVeto + BLOCK_GAP, 0.85);

  const report = {
    generated_at: new Date().toISOString(),
    runner_rows_considered: rows.length,
    contaminated_excluded: true,
    sources_top: Object.entries(bySource)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12),
    labeled_scored: scored,
    min_labeled_required: MIN_LABELED,
    confusion: { tp, fp, tn, fn, precision, recall, f1 },
    veto_rate_unlabeled_ok: vetoRate,
    live: { veto: liveVeto, block: liveBlock },
    proposed_shadow: { veto: proposedVeto, block: proposedBlock, reason: proposalReason },
    write: {
      requested: writeRequested,
      enabled: writeEnabled,
      would_touch_live_keys: false,
      forbidden_live_keys: [...LIVE_VETO_KEYS],
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (!writeEnabled) {
    console.log('[shadow-autotune] dry-run complete (no writes)');
    return;
  }

  if (scored < MIN_LABELED) {
    console.error('[shadow-autotune] refusing shadow write: labeled_scored < MIN_LABELED');
    process.exit(3);
  }

  // Safety: never write live keys
  for (const k of LIVE_VETO_KEYS) {
    if (k === SHADOW_VETO_KEY || k === SHADOW_BLOCK_KEY) continue;
  }

  const now = new Date().toISOString();
  const upserts = [
    { key: SHADOW_VETO_KEY, value: String(proposedVeto), updated_by: 'xc-shadow-autotune' },
    { key: SHADOW_BLOCK_KEY, value: String(proposedBlock), updated_by: 'xc-shadow-autotune' },
    { key: 'hal_shadow_autotune_last_run', value: now, updated_by: 'xc-shadow-autotune' },
  ];

  for (const u of upserts) {
    if (LIVE_VETO_KEYS.has(u.key)) {
      throw new Error(`REFUSING to write live key ${u.key}`);
    }
    const { error } = await db.from('repid_config').upsert(
      {
        key: u.key,
        value: u.value,
        updated_by: u.updated_by,
        last_updated: now,
      },
      { onConflict: 'key' },
    );
    if (error) {
      console.error('[shadow-autotune] config upsert failed', u.key, error.message);
      process.exit(1);
    }
  }

  const { error: histErr } = await db.from('hal_threshold_updates').insert([
    {
      hal_layer: 2,
      threshold_key: 'veto_threshold_shadow',
      old_value: liveVeto,
      new_value: proposedVeto,
      update_type: 'shadow',
      trigger_event_count: scored,
      trigger_catch_rate: recall,
      effective_at: now,
    },
    {
      hal_layer: 2,
      threshold_key: 'block_threshold_shadow',
      old_value: liveBlock,
      new_value: proposedBlock,
      update_type: 'shadow',
      trigger_event_count: scored,
      trigger_catch_rate: precision,
      effective_at: now,
    },
  ]);
  if (histErr) {
    console.error('[shadow-autotune] history insert failed', histErr.message);
    process.exit(1);
  }

  console.log('[shadow-autotune] shadow keys written (live thresholds untouched)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
