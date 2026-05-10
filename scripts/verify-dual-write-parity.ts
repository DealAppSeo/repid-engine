/**
 * Dual-write parity verifier — BACKEND-HARDENING-FOLLOWUP, 2026-05-09.
 *
 * Confirms hal_evaluations rows match the source-of-truth
 * hal_classifications rows when both writes describe the same
 * evaluation. Run after HAL_EVALUATIONS_DUAL_WRITE=true has been
 * set in production for at least 1 hour, so there's data to match.
 *
 * Usage:
 *   npx ts-node scripts/verify-dual-write-parity.ts            # last 100 hal_evaluations rows
 *   npx ts-node scripts/verify-dual-write-parity.ts --limit 25 # smaller sample
 *
 * Required env: SUPABASE_URL, SUPABASE_SERVICE_KEY (or
 * SUPABASE_SERVICE_ROLE_KEY — both names supported).
 *
 * Important schema note discovered while writing this script:
 *   hal_classifications.prompt_hash       = sha256(prompt).slice(0, 32)  (32 hex chars)
 *   hal_evaluations.prompt_text_hash      = full sha256(prompt)          (64 hex chars)
 * The match key is therefore prompt_text_hash.slice(0, 32) === prompt_hash.
 *
 * Exit codes:
 *   0 — verification ran cleanly (whether or not pairs were found)
 *   1 — env / connection / unexpected error
 *   2 — mismatches found (script ran, but data is divergent)
 */

import 'dotenv/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

interface HalEvalRow {
  id: string;
  ts: string | null;
  mode: string;
  prompt_text_hash: string | null;
  agent_id: string | null;
  gen_provider: string | null;
  gen_model: string | null;
  gen_latency_ms: number | null;
  decision: string | null;
  notes: string | null;
}

interface HalClassRow {
  id: number;
  prompt_hash: string;
  category: string;
  confidence: string;
  latency_ms: number;
  provider: string | null;
  model: string | null;
  created_at: string;
}

interface Pair {
  eval_id: string;
  cls_id: number;
  ts_eval: string | null;
  ts_cls: string;
  prompt_hash_prefix: string;
  delta_seconds: number;
  mismatches: string[];
}

interface UnmatchedEval {
  eval_id: string;
  prompt_text_hash: string | null;
  ts: string | null;
  notes: string | null;
}

const TIMESTAMP_WINDOW_SEC = 5 * 60; // ±5 minutes

function parseLimit(): number {
  const idx = process.argv.indexOf('--limit');
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1]);
    if (Number.isFinite(n) && n > 0 && n <= 1000) return Math.floor(n);
  }
  return 100;
}

function getSupabase(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error(
      '[verify-dual-write-parity] missing env: SUPABASE_URL and ' +
      'SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) are required',
    );
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function comparePair(ev: HalEvalRow, cls: HalClassRow): string[] {
  const mismatches: string[] = [];

  if (ev.gen_provider && cls.provider && ev.gen_provider !== cls.provider) {
    mismatches.push(`provider: eval=${ev.gen_provider} cls=${cls.provider}`);
  }
  if (ev.gen_model && cls.model && ev.gen_model !== cls.model) {
    mismatches.push(`model: eval=${ev.gen_model} cls=${cls.model}`);
  }
  if (
    typeof ev.gen_latency_ms === 'number' &&
    typeof cls.latency_ms === 'number' &&
    Math.abs(ev.gen_latency_ms - cls.latency_ms) > 50 // 50ms tolerance for clock skew
  ) {
    mismatches.push(`latency_ms: eval=${ev.gen_latency_ms} cls=${cls.latency_ms}`);
  }

  return mismatches;
}

async function main(): Promise<void> {
  const limit = parseLimit();
  const sb = getSupabase();

  console.log(`[verify-dual-write-parity] sampling last ${limit} hal_evaluations rows with mode='production'`);

  const { data: evalRows, error: evalErr } = await sb
    .from('hal_evaluations')
    .select('id, ts, mode, prompt_text_hash, agent_id, gen_provider, gen_model, gen_latency_ms, decision, notes')
    .eq('mode', 'production')
    .order('ts', { ascending: false })
    .limit(limit);

  if (evalErr) {
    // Schema may not yet exist (migration not yet applied) — treat as graceful no-op.
    if (/relation .* does not exist/i.test(evalErr.message) || /undefined_table/i.test(evalErr.message)) {
      console.log('[verify-dual-write-parity] hal_evaluations table not present yet; nothing to verify. Exit 0.');
      process.exit(0);
    }
    console.error('[verify-dual-write-parity] hal_evaluations query failed:', evalErr.message);
    process.exit(1);
  }

  const evals = (evalRows ?? []) as HalEvalRow[];
  console.log(`[verify-dual-write-parity] fetched ${evals.length} hal_evaluations rows`);

  if (evals.length === 0) {
    console.log('[verify-dual-write-parity] no production-mode rows yet. Exit 0.');
    process.exit(0);
  }

  // Filter to evaluations that have a hash (so we can match) and timestamp.
  const matchable = evals.filter(e => !!e.prompt_text_hash && !!e.ts);
  console.log(`[verify-dual-write-parity] ${matchable.length} of ${evals.length} have prompt_text_hash + ts`);

  const pairs: Pair[] = [];
  const unmatched: UnmatchedEval[] = [];

  for (const ev of matchable) {
    const prefix = (ev.prompt_text_hash as string).slice(0, 32);
    const tsMs = new Date(ev.ts as string).getTime();
    const winLo = new Date(tsMs - TIMESTAMP_WINDOW_SEC * 1000).toISOString();
    const winHi = new Date(tsMs + TIMESTAMP_WINDOW_SEC * 1000).toISOString();

    const { data: clsRows, error: clsErr } = await sb
      .from('hal_classifications')
      .select('id, prompt_hash, category, confidence, latency_ms, provider, model, created_at')
      .eq('prompt_hash', prefix)
      .gte('created_at', winLo)
      .lte('created_at', winHi)
      .order('created_at', { ascending: false })
      .limit(1);

    if (clsErr) {
      console.warn(`[verify-dual-write-parity] hal_classifications lookup for eval=${ev.id} failed: ${clsErr.message}`);
      continue;
    }

    const cls = (clsRows ?? [])[0] as HalClassRow | undefined;
    if (!cls) {
      unmatched.push({ eval_id: ev.id, prompt_text_hash: ev.prompt_text_hash, ts: ev.ts, notes: ev.notes });
      continue;
    }

    const dt = Math.abs(tsMs - new Date(cls.created_at).getTime()) / 1000;
    const mismatches = comparePair(ev, cls);
    pairs.push({
      eval_id: ev.id,
      cls_id: cls.id,
      ts_eval: ev.ts,
      ts_cls: cls.created_at,
      prompt_hash_prefix: prefix,
      delta_seconds: dt,
      mismatches,
    });
  }

  // ---- Report ----------------------------------------------------------
  const totalChecked = matchable.length;
  const pairCount = pairs.length;
  const unmatchedCount = unmatched.length;
  const mismatchedPairs = pairs.filter(p => p.mismatches.length > 0);

  console.log('');
  console.log('=== Parity report ===');
  console.log(`  hal_evaluations sampled:      ${evals.length}`);
  console.log(`  matchable (hash + ts):        ${totalChecked}`);
  console.log(`  paired with hal_classifications: ${pairCount}`);
  console.log(`  unmatched (no cls within ±${TIMESTAMP_WINDOW_SEC / 60}min):     ${unmatchedCount}`);
  console.log(`  paired but field mismatch:    ${mismatchedPairs.length}`);

  if (unmatchedCount > 0) {
    console.log('');
    console.log('Unmatched hal_evaluations rows (no hal_classifications within window):');
    for (const u of unmatched.slice(0, 10)) {
      console.log(`  - eval_id=${u.eval_id} ts=${u.ts} notes=${(u.notes ?? '').slice(0, 80)}`);
    }
    if (unmatched.length > 10) console.log(`  ... and ${unmatched.length - 10} more`);
    console.log('');
    console.log('Note: rows with notes containing "runScoreEvent strictness=1" or "Paper trade" are EXPECTED to be unmatched —');
    console.log('they describe events that bypass classify() entirely. This is by design.');
  }

  if (mismatchedPairs.length > 0) {
    console.log('');
    console.log('Mismatched paired rows:');
    for (const m of mismatchedPairs.slice(0, 20)) {
      console.log(`  - eval=${m.eval_id} cls=${m.cls_id} Δ=${m.delta_seconds.toFixed(1)}s`);
      for (const issue of m.mismatches) console.log(`      ${issue}`);
    }
    process.exit(2);
  }

  console.log('');
  console.log('OK — no mismatches found among paired rows.');
  process.exit(0);
}

main().catch(e => {
  console.error('[verify-dual-write-parity] unexpected error:', e?.message ?? e);
  process.exit(1);
});
