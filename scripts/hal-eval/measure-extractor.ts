/**
 * P1 measurement (sprint 2026-05-29): does the EXTRACTOR path (strictness 1) —
 * the one the LIVE scoring pipeline uses — separate TRUE from FALSE at all?
 * Pure/local (no providers, no DB). Decisive for DEFECT-CLASS A vs B.
 */
import { evaluate } from '../../src/hal/lib/evaluate';
import { CORPUS } from './corpus';

(async () => {
  const rows: Array<{ n: number; truth: string; cat: string; score: number; vetoed: boolean }> = [];
  for (const item of CORPUS) {
    const r = await evaluate(item.text, item.text, { domain: 'general', certainty: 0.8, strictness: 1 });
    rows.push({ n: item.n, truth: item.truth, cat: item.category, score: +r.hal_score.toFixed(4), vetoed: !!r.vetoed });
  }
  const T = rows.filter(r => r.truth === 'TRUE').map(r => r.score);
  const F = rows.filter(r => r.truth === 'FALSE').map(r => r.score);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const meanT = mean(T), meanF = mean(F);

  // AUC (Mann-Whitney): P(score_FALSE > score_TRUE). 0.5 = no separation.
  let wins = 0, ties = 0;
  for (const f of F) for (const t of T) { if (f > t) wins++; else if (f === t) ties++; }
  const auc = (wins + 0.5 * ties) / (F.length * T.length);

  // Best veto threshold on the corpus (max F1, FALSE=positive).
  let best = { t: 0, f1: 0, prec: 0, rec: 0, TP: 0, FP: 0, FN: 0, TN: 0 };
  for (let t = 0.0; t <= 1.001; t += 0.01) {
    let TP = 0, FP = 0, FN = 0, TN = 0;
    for (const r of rows.filter(r => r.truth === 'TRUE' || r.truth === 'FALSE')) {
      const veto = r.score >= t;
      if (r.truth === 'FALSE') veto ? TP++ : FN++; else veto ? FP++ : TN++;
    }
    const prec = TP / (TP + FP || 1), rec = TP / (TP + FN || 1);
    const f1 = (2 * prec * rec) / (prec + rec || 1);
    if (f1 > best.f1) best = { t: +t.toFixed(2), f1: +f1.toFixed(3), prec: +prec.toFixed(2), rec: +rec.toFixed(2), TP, FP, FN, TN };
  }

  console.log('=== EXTRACTOR (strictness 1) over 20-item labeled corpus ===');
  for (const r of rows) console.log(`#${String(r.n).padStart(2)} ${r.truth.padEnd(5)} ${r.cat.padEnd(11)} score=${r.score.toFixed(3)} vetoed=${r.vetoed}`);
  console.log('\n--- separation ---');
  console.log(`meanTRUE=${meanT.toFixed(4)}  meanFALSE=${meanF.toFixed(4)}  gap=${(meanF - meanT).toFixed(4)}`);
  console.log(`scoreTRUE range=[${Math.min(...T).toFixed(3)}, ${Math.max(...T).toFixed(3)}]  scoreFALSE range=[${Math.min(...F).toFixed(3)}, ${Math.max(...F).toFixed(3)}]`);
  console.log(`AUC(FALSE>TRUE)=${auc.toFixed(3)}   (0.5 = NO separation; 1.0 = perfect)`);
  console.log(`distinct scores across all 20: ${new Set(rows.map(r => r.score)).size}`);
  console.log(`best corpus veto threshold: t=${best.t} F1=${best.f1} prec=${best.prec} rec=${best.rec} (TP${best.TP}/FP${best.FP}/FN${best.FN}/TN${best.TN})`);
  console.log(`\nVERDICT: ${auc < 0.6 ? 'EXTRACTOR HAS ~NO DISCRIMINATIVE POWER (Class B for the live path)' : 'extractor separates (Class A)'}`);
})();
