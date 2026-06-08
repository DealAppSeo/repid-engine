import 'dotenv/config';
import { db } from '../../src/db';
import { halService } from '../../src/hal/service';
import crypto from 'crypto';

const VETO_THRESHOLD = Number(process.env.HAL_VETO_THRESHOLD ?? '0.5');

async function main() {
  console.log("🚀 Starting HAL Validation Audit & Sweep...");
  const runId = crypto.randomUUID();

  // 1. Fetch test cases for the 5 target categories
  const categories = ['math', 'code', 'opinion', 'creative', 'time-sensitive'];
  const { data: cases, error } = await db
    .from('hal_test_cases')
    .select('id, prompt_text, category, expected_decision, expected_hallucination, difficulty')
    .in('category', categories);

  if (error || !cases) {
    console.error("Failed to fetch test cases:", error?.message);
    process.exit(1);
  }

  console.log(`Fetched ${cases.length} test cases.`);

  const results: any[] = [];

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
        context: { domain: c.category, certainty: 0.8 },
        strictness: 2
      });
    } catch (err: any) {
      console.log(`❌ Error: ${err.message}`);
      continue;
    }
    
    const latency = Date.now() - t0;
    console.log(`✅ score=${response.hal_score.toFixed(3)} decision=${response.decision}`);

    // Map response models and providers
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
      // v1.1: rebased onto main, where provider_responses[].model is populated, so `model`
      // is the real per-provider model string (not 'unknown'). Free-tier family-diverse quorum.
      harness_version: 't12-audit-v1.1'
    });

    if (insertErr) {
      console.error(`Failed to insert validation run:`, insertErr.message);
    }

    results.push({
      case_id: c.id,
      category: c.category,
      expected_decision: c.expected_decision,
      expected_hallucination: c.expected_hallucination,
      hal_score: response.hal_score,
      hal_decision: response.decision,
      providers
    });

    // Cooldown to prevent rate limit triggers
    await new Promise(resolve => setTimeout(resolve, 1500));
  }

  // 3. Perform Threshold Sweep (FALSE/veto is the positive condition we want to catch)
  console.log("\n=== THRESHOLD SWEEP ANALYSIS ===");
  const sweep: any[] = [];
  
  for (let t = 0.05; t <= 0.951; t += 0.05) {
    let TP = 0, FP = 0, FN = 0, TN = 0;
    for (const r of results) {
      const predictedVeto = r.hal_score >= t;
      const actualVeto = r.expected_decision === 'veto';
      
      if (actualVeto) {
        predictedVeto ? TP++ : FN++;
      } else {
        predictedVeto ? FP++ : TN++;
      }
    }
    const precision = TP / (TP + FP || 1);
    const recall = TP / (TP + FN || 1);
    const f1 = (2 * precision * recall) / (precision + recall || 1);
    const castrationCost = FP / (FP + TN || 1); // False Veto Rate / False Positive Rate
    
    sweep.push({
      threshold: +t.toFixed(2),
      TP, FP, FN, TN,
      precision: +precision.toFixed(4),
      recall: +recall.toFixed(4),
      f1: +f1.toFixed(4),
      castrationCost: +castrationCost.toFixed(4)
    });
  }

  // Find best threshold by F1
  const best = sweep.reduce((max, s) => s.f1 > max.f1 ? s : max, sweep[0]);

  console.log(`\nOptimal Veto Threshold (Max F1):`);
  console.log(`- Threshold: ${best.threshold}`);
  console.log(`- F1 Score:  ${best.f1.toFixed(4)}`);
  console.log(`- Precision: ${best.precision.toFixed(4)}`);
  console.log(`- Recall:    ${best.recall.toFixed(4)}`);
  console.log(`- Castration Cost (False Veto Rate): ${(best.castrationCost * 100).toFixed(2)}%`);
  console.log(`- Confusion Matrix: TP=${best.TP}, FP=${best.FP}, FN=${best.FN}, TN=${best.TN}`);

  // 4. Print Per-Category Table under Optimal Threshold
  console.log("\n=== PER-CATEGORY METRICS (At Optimal Threshold) ===");
  const categoriesList = Array.from(new Set(results.map(r => r.category)));
  
  console.log(`| Category | Precision | Recall | F1 | Castration Cost |`);
  console.log(`| --- | --- | --- | --- | --- |`);
  
  for (const cat of categoriesList) {
    const catResults = results.filter(r => r.category === cat);
    let TP = 0, FP = 0, FN = 0, TN = 0;
    
    for (const r of catResults) {
      const predictedVeto = r.hal_score >= best.threshold;
      const actualVeto = r.expected_decision === 'veto';
      
      if (actualVeto) {
        predictedVeto ? TP++ : FN++;
      } else {
        predictedVeto ? FP++ : TN++;
      }
    }
    
    const precision = TP / (TP + FP || 1);
    const recall = TP / (TP + FN || 1);
    const f1 = (2 * precision * recall) / (precision + recall || 1);
    const castrationCost = FP / (FP + TN || 1);
    
    console.log(`| ${cat.padEnd(14)} | ${precision.toFixed(4)} | ${recall.toFixed(4)} | ${f1.toFixed(4)} | ${(castrationCost * 100).toFixed(2)}% |`);
  }

  console.log(`\nRun completed. run_id: ${runId}`);
}

main().catch(console.error);
