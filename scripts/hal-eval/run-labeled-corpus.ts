/**
 * P1/P2 (sprint 2026-05-30): run the labeled corpus against CURRENT HAL and write
 * labeled rows to hal_runner_results. MEASURE-ONLY — no scoring/threshold/penalty
 * change. Fixes the disconnect that left hal_runner_results unlinked to ground truth.
 *
 *   Reads hal_test_cases (109: prompt_text + expected_hallucination)
 *   For each: runs BOTH paths —
 *     fact-check (halService strictness 2, cross-LLM = the canonical hal_runner pipeline)
 *     extractor  (evaluate strictness 1 = the LIVE score-event path, for the PR#77 diagnosis)
 *   Writes the FACT-CHECK result to hal_runner_results with ground_truth + was_caught + false_positive,
 *   and prints the extractor scores so both confusion matrices can be computed.
 *
 *   GROQ_API_KEY/FIREWORKS_API_KEY/CEREBRAS_API_KEY + SUPABASE_* required (env).
 */
import { db } from '../../src/db';
import { halService } from '../../src/hal/service';
import { evaluate } from '../../src/hal/lib/evaluate';
import { execSync } from 'child_process';

const VETO = Number(process.env.HAL_VETO_THRESHOLD ?? '0.43');

function commit(): string { try { return execSync('git rev-parse HEAD').toString().trim().slice(0, 12); } catch { return 'unknown'; } }

(async () => {
  const runId = `cc-measure-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const eng = commit();
  console.log(`[run] run_id=${runId} commit=${eng} veto=${VETO}`);

  const { data: cases, error } = await db
    .from('hal_test_cases')
    .select('id, prompt_text, expected_hallucination, category, difficulty')
    .order('id');
  if (error || !cases) { console.error('read hal_test_cases failed:', error?.message); process.exit(1); }
  console.log(`[run] ${cases.length} labeled cases`);

  // confusion accumulators (positive = hallucination)
  const fc = { tp: 0, fp: 0, fn: 0, tn: 0, fail: 0 };
  const ex = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const extractorRows: any[] = [];

  for (const c of cases as any[]) {
    const gt = c.expected_hallucination === true; // ground truth
    let halScore = 0.5, vetoed = false, vetoClass: string | null = null, commaGap: number | null = null;
    let providers: string[] = [], signals: any = {}, genFailed = false, failReason: string | null = null;
    const t0 = Date.now();
    try {
      const r = await halService.evaluate({ text: c.prompt_text, context: { domain: 'general', certainty: 0.8 }, strictness: 2 });
      halScore = Number.isFinite(r.hal_score) ? r.hal_score : 0.5;
      vetoed = r.decision === 'vetoed' || halScore >= VETO;
      vetoClass = r.decision;
      signals = r.signals ?? {};
      commaGap = typeof (signals as any).comma_gap === 'number' ? (signals as any).comma_gap : null;
      providers = Array.isArray((signals as any).provider_health) ? (signals as any).provider_health.map((p: any) => p.provider ?? p) : ((signals as any).providers_used != null ? [`used:${(signals as any).providers_used}`] : []);
      if ((signals as any).degraded || (signals as any).providers_used === 0) { genFailed = true; failReason = (signals as any).quorum_note ?? 'no provider responded'; }
    } catch (e: any) {
      genFailed = true; failReason = e?.message ?? String(e);
    }
    const latency = Date.now() - t0;

    const wasCaught = gt && vetoed;
    const falsePositive = !gt && vetoed;
    if (genFailed) fc.fail++;
    if (gt) (vetoed ? fc.tp++ : fc.fn++); else (vetoed ? fc.fp++ : fc.tn++);

    // extractor (live path) for PR#77 diagnosis
    let exScore = 0.5, exVeto = false;
    try {
      const er = await evaluate(c.prompt_text, c.prompt_text, { domain: 'general', certainty: 0.8, strictness: 1 });
      exScore = Number.isFinite(er.hal_score) ? er.hal_score : 0.5;
      exVeto = !!er.vetoed || exScore >= VETO;
    } catch { /* extractor is pure; ignore */ }
    if (gt) (exVeto ? ex.tp++ : ex.fn++); else (exVeto ? ex.fp++ : ex.tn++);
    extractorRows.push({ id: c.id, gt, exScore: +exScore.toFixed(4), exVeto });

    // veto_class CHECK constraint allows {BFT_CONTRADICTION, FACTUAL_ERROR, UNKNOWN, null}
    const vc = !vetoed ? null : (genFailed ? 'UNKNOWN' : 'FACTUAL_ERROR');
    const { error: insErr } = await db.from('hal_runner_results').insert({
      run_id: runId,
      prompt_id: String(c.id),
      benchmark_source: 'hal_test_cases',
      repid_engine_commit: eng,
      gen_provider: 'corpus', gen_model: 'labeled-claim', generated_answer: c.prompt_text,
      hal_mode: 'fact-check-s2', hal_threshold: VETO,
      hal_score: halScore, hal_vetoed: vetoed, veto_class: vc, comma_gap: commaGap,
      signals: { ...signals, decision: vetoClass, ex_score: +exScore.toFixed(4), ex_veto: exVeto }, hal_latency_ms: latency, hal_providers_used: providers, estimated_cost_usd: 0,
      ground_truth_is_hallucination: gt, was_caught: wasCaught, false_positive: falsePositive,
      gen_failed: genFailed, gen_failure_reason: failReason, providers_attempted: providers,
    });
    if (insErr) console.error(`  insert FAILED #${c.id}: ${insErr.message}`);
    process.stdout.write(`#${c.id} gt=${gt ? 'H' : 'C'} fc=${halScore.toFixed(3)}/${vetoed ? 'VETO' : 'pass'} ex=${exScore.toFixed(3)}/${exVeto ? 'VETO' : 'pass'}${genFailed ? ' [FAIL:' + failReason?.slice(0, 20) + ']' : ''}\n`);
  }

  const f1 = (m: any) => { const p = m.tp / (m.tp + m.fp || 1), r = m.tp / (m.tp + m.fn || 1); return { p: +p.toFixed(3), r: +r.toFixed(3), f1: +((2 * p * r) / (p + r || 1)).toFixed(3) }; };
  console.log(`\n=== FACT-CHECK (current full HAL) === run_id=${runId}`);
  console.log(`TP=${fc.tp} FP=${fc.fp} FN=${fc.fn} TN=${fc.tn} provider_fail=${fc.fail}`, f1(fc));
  console.log(`=== EXTRACTOR (live score-event path) ===`);
  console.log(`TP=${ex.tp} FP=${ex.fp} FN=${ex.fn} TN=${ex.tn}`, f1(ex));
  const exH = extractorRows.filter(r => r.gt).map(r => r.exScore), exC = extractorRows.filter(r => !r.gt).map(r => r.exScore);
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  console.log(`extractor separation: meanH=${mean(exH).toFixed(4)} meanC=${mean(exC).toFixed(4)} gap=${(mean(exH) - mean(exC)).toFixed(4)}`);
  console.log(`\nRUN_ID=${runId}`);
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
