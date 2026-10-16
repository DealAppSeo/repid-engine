/**
 * CHECK 4 — HAL discrimination on the labeled corpus.
 * Runs hal_test_cases through the INTENDED path (fact-check, halService strictness 2),
 * computes TP/FP/FN/TN + F1 + separation (mean hallucination score − mean correct score),
 * and asserts F1 ≥ threshold AND separation > 0. Catches a HAL regression to "blind"
 * (the live extractor path gives separation ≈ −0.014; full-quorum fact-check ≈ +0.4..+0.7).
 *
 * Provider-dependent. Behavior when it can't run cleanly (never a silent pass):
 *   - <2 provider keys                → SKIP('needs ≥2 provider keys')
 *   - >50% of samples had provider failures → SKIP('provider-degraded NN%')  [HAL is provider-fragile]
 *   - clean run, F1<thr or sep≤0      → FAIL (real regression)
 *
 * Tunables: HAL_CHECK_SAMPLE (default 30; 0=all), HAL_VETO_THRESHOLD (0.43),
 *           HAL_CHECK_MIN_F1 (0.70), HAL_RULER (default: newest hal-sealed-v<N>).
 *
 * The cases come from a named ruler (src/hal/sealed-ruler.ts), never the readable table, and the
 * F1 is reported with that ruler's id, hash and N (a sample is minted `<ruler>/subset`).
 */
import { CheckResult, pass, fail, skip } from '../lib/types';
import { getDb } from '../lib/db';
import { DEFAULT_RULER_ID, caseFamilies, harnessWidth, loadRulerSelection, ruledReport } from '../../../src/hal/sealed-ruler';

const ID = 'hal';
const TITLE = 'HAL discrimination on labeled corpus (F1 + separation)';

const VETO = Number(process.env.HAL_VETO_THRESHOLD ?? '0.43');
const SAMPLE = Number(process.env.HAL_CHECK_SAMPLE ?? '30');
const MIN_F1 = Number(process.env.HAL_CHECK_MIN_F1 ?? '0.70');

function providerKeyCount(): number {
  return ['GROQ_API_KEY', 'FIREWORKS_API_KEY', 'CEREBRAS_API_KEY'].filter(k => !!process.env[k]).length;
}

/** balanced sample: interleave so a truncated run keeps both classes. */
function sampleCases(cases: any[], n: number): any[] {
  if (!n || n >= cases.length) return cases;
  const H = cases.filter(c => c.expected_hallucination === true);
  const C = cases.filter(c => c.expected_hallucination !== true);
  const out: any[] = [];
  for (let i = 0; out.length < n && (i < H.length || i < C.length); i++) {
    if (i < H.length) out.push(H[i]);
    if (out.length < n && i < C.length) out.push(C[i]);
  }
  return out;
}

export async function halCheck(): Promise<CheckResult> {
  const db = getDb();
  if (!db) return skip(ID, TITLE, 'needs SUPABASE_URL + SUPABASE_SERVICE_KEY', true);
  const keys = providerKeyCount();
  if (keys < 2) return skip(ID, TITLE, `needs ≥2 provider keys (have ${keys}) — GROQ/FIREWORKS/CEREBRAS`, true);

  let halService: any;
  try {
    // require (not dynamic import) so ts-node resolves the .ts module under CJS
    halService = require('../../../src/hal/service').halService;
    if (!halService?.evaluate) throw new Error('halService.evaluate missing');
  } catch (e: any) {
    return skip(ID, TITLE, `could not load halService: ${e?.message ?? e}`, true);
  }

  let sel;
  try {
    sel = await loadRulerSelection(db, process.env.HAL_RULER || DEFAULT_RULER_ID);
  } catch (e: any) {
    return skip(ID, TITLE, `ruler refused: ${e?.message ?? e}`, true);
  }

  const cases = sampleCases(sel.rows, SAMPLE);
  const m = { tp: 0, fp: 0, fn: 0, tn: 0 };
  let failed = 0;
  const scoresH: number[] = [], scoresC: number[] = [];
  const scored: { id: string; predictedHallucination: boolean }[] = [];
  const families: number[] = [];

  for (const c of cases) {
    const gt = c.expected_hallucination === true;
    let score = 0.5, vetoed = false, degraded = false;
    try {
      const r = await halService.evaluate({ text: c.prompt_text, context: { domain: 'general', certainty: 0.8 }, strictness: 2 });
      score = Number.isFinite(r.hal_score) ? r.hal_score : 0.5;
      vetoed = r.decision === 'vetoed' || score >= VETO;
      const s = r.signals ?? {};
      if (s.degraded || s.providers_used === 0 || s.providers_used === 1) degraded = true;
      families.push(caseFamilies(2, s));
    } catch {
      degraded = true;
      families.push(0);
    }
    if (degraded) failed++;
    scored.push({ id: String(c.id), predictedHallucination: vetoed });
    (gt ? scoresH : scoresC).push(score);
    if (gt) (vetoed ? m.tp++ : m.fn++); else (vetoed ? m.fp++ : m.tn++);
  }

  const n = cases.length;
  const failRate = failed / (n || 1);
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const meanH = mean(scoresH), meanC = mean(scoresC);
  const separation = meanH - meanC;
  const report = ruledReport(sel, scored, harnessWidth({
    strictness: 2,
    familiesConfigured: keys,
    perCaseFamilies: families,
    decisionRequiresQuorum: /^(1|true|yes|on)$/i.test(process.env.HAL_DECISION_REQUIRES_QUORUM ?? ''),
    penaltyRequiresQuorum: /^(1|true|yes|on)$/i.test(process.env.HAL_PENALTY_REQUIRES_QUORUM ?? ''),
  }));
  const p = report.overall.metrics.precision ?? 0, rec = report.overall.metrics.recall ?? 0;
  const f1 = report.overall.metrics.f1 ?? 0;
  const cite = report.overall.citation;

  const detail = {
    sampled: n, veto_threshold: VETO, provider_keys: keys, ruler: report.lines,
    confusion: m, precision: +p.toFixed(3), recall: +rec.toFixed(3), f1: +f1.toFixed(3),
    mean_score_hallucination: +meanH.toFixed(3), mean_score_correct: +meanC.toFixed(3), separation: +separation.toFixed(3),
    provider_fail_rate: +failRate.toFixed(2), min_f1: MIN_F1,
  };

  // provider-fragility (a known property of fact-check, not a scorer regression) → SKIP, never block.
  if (failRate > 0.5) {
    return skip(ID, TITLE, `provider-degraded ${Math.round(failRate * 100)}% of ${n} samples — can't certify`, true, detail);
  }
  if (separation <= 0) {
    return fail(ID, TITLE, `BLIND: separation ${separation.toFixed(3)} ≤ 0 (mean H ${meanH.toFixed(2)} vs C ${meanC.toFixed(2)})`, true, detail);
  }
  if (f1 < MIN_F1) {
    return fail(ID, TITLE, `${cite} < ${MIN_F1} (sep ${separation.toFixed(3)} ok)`, true, detail);
  }
  return pass(ID, TITLE, `${cite} ≥ ${MIN_F1}, separation +${separation.toFixed(3)} (n=${n}, ${Math.round(failRate * 100)}% provider-fail)`, true, detail);
}
