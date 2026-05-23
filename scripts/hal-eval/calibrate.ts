/**
 * HAL calibration harness — runs extractor (strictness:1) + fact-check evaluator
 * against the ground-truth corpus, computes discrimination metrics + a veto
 * threshold sweep, and writes results JSON. Reusable: re-run after any tuning.
 *
 *   GROQ_API_KEY=.. CEREBRAS_API_KEY=.. FIREWORKS_API_KEY=.. npx tsx scripts/hal-eval/calibrate.ts
 */
import { evaluate } from '../../src/hal/lib/evaluate';
import { factCheck, buildFactCheckProviders } from '../../src/hal/fact-check';
import { CORPUS } from './corpus';
import * as fs from 'fs';

const dec1 = (s: number, v: boolean, sev: any) => (v || sev === 'critical' ? 'vetoed' : s >= 0.4 ? 'flagged' : 'clean');

(async () => {
  const providers = buildFactCheckProviders();
  console.log('fact-check providers:', providers.map((p) => p.name).join('+') || 'NONE');
  const rows: any[] = [];
  for (const item of CORPUS) {
    const s1 = await evaluate(item.text, item.text, { domain: 'general', certainty: 0.8, strictness: 1 });
    const s1dec = dec1(s1.hal_score, s1.vetoed, (s1.signals as any).comma_severity);
    const fc = await factCheck(item.text, providers, {});
    rows.push({
      n: item.n, truth: item.truth, category: item.category,
      s1_score: +s1.hal_score.toFixed(4), s1_dec: s1dec,
      fc_score: +fc.hal_score.toFixed(4), fc_dec: fc.decision, fc_providers: fc.providers_used,
      fc_agreement: fc.agreement, fc_latency_ms: fc.latency_ms,
      verdicts: fc.verdicts.map((v) => `${v.provider}:${v.verdict}/${v.confidence}${v.error ? '(' + v.error.slice(0, 18) + ')' : ''}`),
    });
    console.log(`#${String(item.n).padStart(2)} ${item.truth.padEnd(5)} ${item.category.padEnd(11)} s1=${s1.hal_score.toFixed(3)}/${s1dec.padEnd(7)} fc=${fc.hal_score.toFixed(3)}/${fc.decision.padEnd(7)} prov=${fc.providers_used} [${fc.verdicts.map((v) => v.provider[0] + ':' + v.verdict[0] + v.confidence).join(' ')}]`);
  }

  const T = rows.filter((r) => r.truth === 'TRUE');
  const F = rows.filter((r) => r.truth === 'FALSE');
  const A = rows.filter((r) => r.truth === 'AMBIG');
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const meanT = mean(T.map((r) => r.fc_score));
  const meanF = mean(F.map((r) => r.fc_score));
  const s1meanT = mean(T.map((r) => r.s1_score));
  const s1meanF = mean(F.map((r) => r.s1_score));

  // Threshold sweep on fc_score (FALSE = positive = should veto).
  const sweep: any[] = [];
  for (let t = 0.05; t <= 0.951; t += 0.05) {
    let TP = 0, FP = 0, FN = 0, TN = 0;
    for (const r of [...T, ...F]) {
      const veto = r.fc_score >= t;
      if (r.truth === 'FALSE') veto ? TP++ : FN++;
      else veto ? FP++ : TN++;
    }
    const prec = TP / (TP + FP || 1), rec = TP / (TP + FN || 1);
    const f1 = (2 * prec * rec) / (prec + rec || 1), acc = (TP + TN) / (TP + TN + FP + FN);
    sweep.push({ t: +t.toFixed(2), TP, FP, FN, TN, prec: +prec.toFixed(2), rec: +rec.toFixed(2), f1: +f1.toFixed(3), acc: +acc.toFixed(2) });
  }
  const best = sweep.reduce((b, s) => (s.f1 > b.f1 ? s : b), sweep[0]);

  const conf = (key: string) => {
    let TP = 0, FP = 0, FN = 0, TN = 0;
    for (const r of [...T, ...F]) {
      const caught = r[key] === 'vetoed' || r[key] === 'flagged';
      if (r.truth === 'FALSE') caught ? TP++ : FN++;
      else caught ? FP++ : TN++;
    }
    return { caught_false: `${TP}/${F.length}`, over_caught_true: `${FP}/${T.length}`, TP, FP, FN, TN };
  };

  console.log(`\n=== DISCRIMINATION ===`);
  console.log(`s1 score: meanTRUE=${s1meanT.toFixed(3)} meanFALSE=${s1meanF.toFixed(3)} gap=${(s1meanF - s1meanT).toFixed(3)}`);
  console.log(`fc score: meanTRUE=${meanT.toFixed(3)} meanFALSE=${meanF.toFixed(3)} gap=${(meanF - meanT).toFixed(3)}`);
  console.log(`fc optimal veto threshold (max F1): t=${best.t} F1=${best.f1} acc=${best.acc} (TP${best.TP}/FP${best.FP}/FN${best.FN}/TN${best.TN})`);
  console.log(`s1 confusion (veto|flag=catch): ${JSON.stringify(conf('s1_dec'))}`);
  console.log(`fc confusion (veto|flag=catch, default thr 0.5/0.35): ${JSON.stringify(conf('fc_dec'))}`);
  console.log(`AMBIG fc decisions: ${A.map((r) => r.n + ':' + r.fc_dec).join(' ')}`);

  fs.writeFileSync('E:/dev/reports/2026-05-23/hal-calibrate-results.json', JSON.stringify({ rows, metrics: { s1meanT, s1meanF, meanT, meanF, gap: meanF - meanT }, sweep, best, conf_s1: conf('s1_dec'), conf_fc: conf('fc_dec') }, null, 2));
  console.log('\n-> E:/dev/reports/2026-05-23/hal-calibrate-results.json');
})();
