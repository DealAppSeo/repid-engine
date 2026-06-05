/**
 * S-HAL-ABLATION Phase 2 (headline, strong-N) — B vs C on the PERSISTED healthy run.
 *
 * The fresh full-corpus ablation is provider-throttled today (fireworks account suspended, groq
 * daily-capped, cerebras RPM-capped), so a fresh 165-case quorum run isn't possible. But the
 * cc-measure-2026-05-30 run already persisted 109 labeled cases through BOTH paths while providers
 * were healthy: hal_runner_results.hal_score = B (fact-check/HAL), signals.ex_score = C (extractor),
 * ground_truth_is_hallucination = label. We recompute AUC/F1/precision/recall/veto-rate/separation
 * for B and C from that persisted data. (Plain-majority A is NOT reconstructable here — per-provider
 * verdicts weren't stored — so A vs B0 vs B comes from the fresh cached quorum set instead.)
 *
 * Run: RUN_ID=cc-measure-2026-05-30T04-25-26-088Z ts-node scripts/hal-ablation/persisted-analyze.ts
 */
import { db } from '../../src/db';
import * as fs from 'fs';
import * as path from 'path';

const RUN_ID = process.env.RUN_ID ?? 'cc-measure-2026-05-30T04-25-26-088Z';
const DATA = path.join(__dirname, 'data');

function aucROC(scores: number[], labels: boolean[]): number {
  const n = scores.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  const rank = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && scores[idx[j + 1]!]! === scores[idx[i]!]!) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) rank[idx[k]!] = avg;
    i = j + 1;
  }
  let sumPos = 0, nPos = 0, nNeg = 0;
  for (let t = 0; t < n; t++) { if (labels[t]) { sumPos += rank[t]!; nPos++; } else nNeg++; }
  if (nPos === 0 || nNeg === 0) return NaN;
  return (sumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}
function metricsAt(scores: number[], labels: boolean[], thr: number) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let i = 0; i < scores.length; i++) { const p = scores[i]! >= thr; if (labels[i]) p ? tp++ : fn++; else p ? fp++ : tn++; }
  const precision = tp / (tp + fp || 1), recall = tp / (tp + fn || 1);
  const f1 = (2 * precision * recall) / (precision + recall || 1);
  const pos = scores.filter((_, i) => labels[i]), neg = scores.filter((_, i) => !labels[i]);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  return {
    n: scores.length, threshold: thr, auc: +aucROC(scores, labels).toFixed(4),
    f1: +f1.toFixed(4), precision: +precision.toFixed(4), recall: +recall.toFixed(4),
    veto_rate: +((tp + fp) / (scores.length || 1)).toFixed(4), separation: +(mean(pos) - mean(neg)).toFixed(4),
    tp, fp, fn, tn,
  };
}

(async () => {
  const { data, error } = await db
    .from('hal_runner_results')
    .select('hal_score, hal_vetoed, signals, ground_truth_is_hallucination, gen_failed')
    .eq('run_id', RUN_ID);
  if (error || !data) { console.error('read failed:', error?.message); process.exit(1); }
  const rows = (data as any[]).filter((r) => r.ground_truth_is_hallucination !== null);
  console.log(`[persisted] run_id=${RUN_ID} rows=${rows.length}`);

  const gt = rows.map((r) => r.ground_truth_is_hallucination === true);
  const bScore = rows.map((r) => Number(r.hal_score));
  const cScore = rows.map((r) => Number(r.signals?.ex_score ?? 0.5));
  const fails = rows.filter((r) => r.gen_failed === true).length;

  // B (fact-check/HAL) thresholded at the calibrated 0.43; C (extractor) at the production 0.25.
  const B = metricsAt(bScore, gt, Number(process.env.B_THRESHOLD ?? '0.43'));
  const C = metricsAt(cScore, gt, 0.25);

  const out = { run_id: RUN_ID, n: rows.length, gen_failed: fails, B_factcheck: B, C_extractor: C,
    delta_auc_B_minus_C: +(B.auc - C.auc).toFixed(4), delta_f1_B_minus_C: +(B.f1 - C.f1).toFixed(4) };
  fs.writeFileSync(path.join(DATA, 'persisted-bc.json'), JSON.stringify(out, null, 2));

  const pad = (s: any, n: number) => String(s).padEnd(n);
  console.log(`\n=== PERSISTED B vs C (N=${rows.length}, healthy providers, run ${RUN_ID}) ===`);
  console.log(`provider-gen failures in run: ${fails}`);
  console.log(pad('scorer', 22) + pad('N', 5) + pad('thr', 6) + pad('AUC', 8) + pad('F1', 8) + pad('prec', 8) + pad('recall', 8) + pad('veto%', 8) + pad('sep', 8));
  console.log(pad('B_factcheck_HAL', 22) + pad(B.n, 5) + pad(B.threshold, 6) + pad(B.auc, 8) + pad(B.f1, 8) + pad(B.precision, 8) + pad(B.recall, 8) + pad(B.veto_rate, 8) + pad(B.separation, 8));
  console.log(pad('C_extractor_prod', 22) + pad(C.n, 5) + pad(C.threshold, 6) + pad(C.auc, 8) + pad(C.f1, 8) + pad(C.precision, 8) + pad(C.recall, 8) + pad(C.veto_rate, 8) + pad(C.separation, 8));
  console.log(`\nB − C: ΔAUC=${out.delta_auc_B_minus_C}  ΔF1=${out.delta_f1_B_minus_C}`);
  console.log(`wrote ${path.join(DATA, 'persisted-bc.json')}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
