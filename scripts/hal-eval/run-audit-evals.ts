/**
 *   npx ts-node scripts/hal-eval/run-audit-evals.ts [--ruler hal-sealed-v1] [--source <tag>] [--sweep]
 *
 * Measures HAL on the 5 audit categories of a named ruler (default: the newest hal-sealed-v<N>, see
 * src/hal/sealed-ruler.ts) at the configured HAL_VETO_THRESHOLD. A category/source filter is a
 * subset of the ruler, so it is reported as `<ruler>/subset` with its own hash.
 *
 * --sweep prints F1 across thresholds. That is TUNING: a threshold picked on sealed items makes every
 * later score on that ruler optimistic, so it is off by default and prints a warning when on.
 */
import 'dotenv/config';
import { db } from '../../src/db';
import { halService } from '../../src/hal/service';
import { buildFactCheckProviders } from '../../src/hal/fact-check';
import { describeCorpus } from '../../src/hal/corpus-manifest';
import { caseFamilies, harnessWidth, loadRulerSelection, ruledReport, rulerFromArgv } from '../../src/hal/sealed-ruler';
import crypto from 'crypto';

const VETO_THRESHOLD = Number(process.env.HAL_VETO_THRESHOLD ?? '0.5');
const envTrue = (k: string) => /^(1|true|yes|on)$/i.test(process.env[k] ?? '');

async function main() {
  console.log("🚀 Starting HAL Validation Audit & Sweep...");
  const runId = crypto.randomUUID();

  // 1. The ruler's cases in the 5 target categories.
  //    CC3: --source <tag> restricts to a corpus version (logged for reproducibility).
  const categories = ['math', 'code', 'opinion', 'creative', 'time-sensitive'];
  const srcIdx = process.argv.indexOf('--source');
  const sourceFilter = srcIdx >= 0 && srcIdx + 1 < process.argv.length ? process.argv[srcIdx + 1] : undefined;
  const sel = await loadRulerSelection<{ id: string; prompt_text: string; expected_hallucination: boolean; source?: string | null; category?: string | null }>(
    db, rulerFromArgv(), ['category'],
  );
  const cases = sel.rows.filter((c) => categories.includes(String(c.category)) && (!sourceFilter || c.source === sourceFilter));
  console.log(`Selected ${cases.length} of ${describeCorpus(sel.manifest)}${sourceFilter ? ` (source='${sourceFilter}')` : ''}.`);

  const results: { case_id: string; category: string; expected_hallucination: boolean; hal_score: number; families: number }[] = [];

  // 2. Evaluate each case
  let count = 0;
  for (const c of cases) {
    count++;
    process.stdout.write(`Evaluating case ${count}/${cases.length} (${c.category})... `);
    const t0 = Date.now();

    let response;
    try {
      response = await halService.evaluate({
        text: c.prompt_text,
        context: { domain: String(c.category), certainty: 0.8 },
        strictness: 2
      });
    } catch (err: any) {
      console.log(`❌ Error: ${err.message}`);
      continue;
    }

    const latency = Date.now() - t0;
    console.log(`✅ score=${response.hal_score.toFixed(3)} decision=${response.decision}`);

    const providers = response.provider_responses
      ? (response.provider_responses as any[]).map(r => r.provider).join(',')
      : 'unknown';
    const models = response.provider_responses
      ? (response.provider_responses as any[]).map(r => r.model ?? 'unknown').join(',')
      : 'unknown';

    // Log to hal_validation_runs
    const { error: insertErr } = await db.from('hal_validation_runs').insert({
      run_id: runId,
      test_case_id: c.id,
      hal_decision: response.decision,
      hal_score: response.hal_score,
      // W5/B2: fold the resolved strictness into the logged signals so each run row records
      // the HAL mode it was measured under (the table has no dedicated strictness column).
      hal_signals: { ...(response.signals as Record<string, unknown>), strictness: response.strictness },
      correct: response.decision === 'vetoed' ? c.expected_hallucination : !c.expected_hallucination,
      latency_ms: latency,
      provider: providers,
      model: models,
      run_at: new Date().toISOString(),
      harness_version: 't12-audit-v1.2'
    });
    if (insertErr) console.error(`Failed to insert validation run:`, insertErr.message);

    results.push({
      case_id: String(c.id),
      category: String(c.category),
      expected_hallucination: c.expected_hallucination,
      hal_score: response.hal_score,
      families: caseFamilies(2, response.signals),
    });

    // Cooldown to prevent rate limit triggers
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  // 3. Ruled metrics at the configured threshold, split public-benchmark vs internal and by category.
  const width = harnessWidth({
    strictness: 2,
    familiesConfigured: new Set(buildFactCheckProviders().map((p) => p.family ?? p.name)).size,
    perCaseFamilies: results.map((r) => r.families),
    decisionRequiresQuorum: envTrue('HAL_DECISION_REQUIRES_QUORUM'),
    penaltyRequiresQuorum: envTrue('HAL_PENALTY_REQUIRES_QUORUM'),
  });
  const report = ruledReport(
    sel,
    results.map((r) => ({ id: r.case_id, predictedHallucination: r.hal_score >= VETO_THRESHOLD })),
    width,
    { breakdowns: { category: (r) => r.category } },
  );
  console.log(`\n=== RULED METRICS (veto threshold ${VETO_THRESHOLD}) ===`);
  for (const line of report.lines) console.log(line);

  // 4. Optional threshold sweep (tuning).
  if (process.argv.includes('--sweep')) {
    const on = describeCorpus(report.overall.ruler.corpus);
    console.log(`\n=== THRESHOLD SWEEP on ${on} ===`);
    console.log(`WARNING: choosing a threshold here tunes on ${sel.rulerId}; a threshold adopted from it makes later ${sel.rulerId} scores optimistic.`);
    for (let t = 0.05; t <= 0.951; t += 0.05) {
      let TP = 0, FP = 0, FN = 0, TN = 0;
      for (const r of results) {
        const predictedVeto = r.hal_score >= t;
        if (r.expected_hallucination) predictedVeto ? TP++ : FN++;
        else predictedVeto ? FP++ : TN++;
      }
      const precision = TP / (TP + FP || 1);
      const recall = TP / (TP + FN || 1);
      const f1 = (2 * precision * recall) / (precision + recall || 1);
      const castrationCost = FP / (FP + TN || 1); // False Veto Rate
      console.log(`t=${t.toFixed(2)} F1=${f1.toFixed(4)} P=${precision.toFixed(4)} R=${recall.toFixed(4)} FVR=${castrationCost.toFixed(4)} tp=${TP} fp=${FP} fn=${FN} tn=${TN} on ${on}`);
    }
  }

  console.log(`\nRun completed. run_id: ${runId}`);
}

main().catch(console.error);
