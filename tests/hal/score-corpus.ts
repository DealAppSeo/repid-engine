import { db } from '../../src/db';
import { HalService } from '../../src/hal/service';
import { buildFactCheckProviders } from '../../src/hal/fact-check';
import { evaluate } from '../../src/hal/lib/evaluate';
import * as crypto from 'crypto';

// Ensure env variables are loaded
import * as dotenv from 'dotenv';
dotenv.config();

interface TestCase {
  id: string;
  prompt_text: string;
  expected_decision: 'veto' | 'pass';
  expected_hallucination: boolean;
  source: string;
  notes: string;
}

interface EvaluationResult {
  testCaseId: string;
  expected: boolean;
  predictedScore: number;
  predictedDecision: 'vetoed' | 'flagged' | 'clean';
  correct: boolean;
  latencyMs: number;
  signals: any;
}

interface Metrics {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
}

function calculateMetrics(results: EvaluationResult[]): Metrics {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  
  for (const r of results) {
    const isVetoed = r.predictedDecision === 'vetoed';
    if (r.expected === true) {
      if (isVetoed) tp++;
      else fn++;
    } else {
      if (isVetoed) fp++;
      else tn++;
    }
  }
  
  const accuracy = (tp + tn) / (tp + fp + tn + fn || 1);
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  const f1 = (2 * precision * recall) / (precision + recall || 1);
  
  return { tp, fp, tn, fn, accuracy, precision, recall, f1 };
}

async function main() {
  console.log('=== Starting HAL External Scoring Harness ===\n');
  
  // 1. Fetch test cases
  console.log('Fetching external test cases from database...');
  const { data: testCases, error: fetchErr } = await db
    .from('hal_test_cases')
    .select('id, prompt_text, expected_decision, expected_hallucination, source, notes')
    .in('source', ['external-truthfulqa-20260606', 'external-fever-20260606', 'external-halueval-20260606']);
    
  if (fetchErr || !testCases) {
    console.error('Failed to fetch test cases:', fetchErr?.message);
    process.exit(1);
  }
  
  const cases = testCases as TestCase[];
  console.log(`Loaded ${cases.length} test cases.`);
  
  // Separate by source
  const truthfulQACases = cases.filter(c => c.source === 'external-truthfulqa-20260606');
  const feverCases = cases.filter(c => c.source === 'external-fever-20260606');
  const haluEvalCases = cases.filter(c => c.source === 'external-halueval-20260606');
  
  console.log(`  TruthfulQA: ${truthfulQACases.length}`);
  console.log(`  FEVER: ${feverCases.length}`);
  console.log(`  HaluEval: ${haluEvalCases.length}\n`);
  
  // Get all available providers
  const allProviders = buildFactCheckProviders();
  console.log('Available Fact Check Providers:');
  for (const p of allProviders) {
    console.log(`  - Name: ${p.name}, Model: ${p.model}, Family: ${p.family}, Tier: ${p.tier}`);
  }
  console.log();
  
  // Configurations to evaluate
  const runId = crypto.randomUUID();
  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
  const PACE_MS = 1200; // Pacing to avoid rate limits
  
  // 2. Evaluate Configuration A: Deployed Extractor (strictness 1)
  console.log('--- Evaluating Deployed Extractor (Strictness 1) ---');
  const extractorResults: EvaluationResult[] = [];
  for (const c of cases) {
    const start = Date.now();
    const r = await evaluate(c.prompt_text, c.prompt_text, {
      domain: 'general',
      certainty: 0.85,
      strictness: 1
    });
    const latency = Date.now() - start;
    const predictedDecision = (r.vetoed ? 'vetoed' : r.hal_score >= 0.4 ? 'flagged' : 'clean') as any;
    const isCorrect = (c.expected_hallucination && predictedDecision === 'vetoed') ||
                      (!c.expected_hallucination && predictedDecision !== 'vetoed');
                      
    extractorResults.push({
      testCaseId: c.id,
      expected: c.expected_hallucination,
      predictedScore: r.hal_score,
      predictedDecision,
      correct: isCorrect,
      latencyMs: latency,
      signals: r.signals
    });
  }
  const extractorMetrics = calculateMetrics(extractorResults);
  console.log(`Extractor F1: ${(extractorMetrics.f1 * 100).toFixed(2)}%\n`);
  
  // 3. Evaluate Configuration B: Groq Only (strictness 2)
  console.log('--- Evaluating Groq Only (Strictness 2) ---');
  const groqProviders = allProviders.filter(p => p.name === 'groq');
  const groqService = new HalService(() => groqProviders);
  const groqResults: EvaluationResult[] = [];
  
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const start = Date.now();
    let r;
    try {
      r = await groqService.evaluate({
        text: c.prompt_text,
        strictness: 2,
        context: { domain: 'general', certainty: 0.85 }
      });
    } catch (err: any) {
      console.error(`Error on item ${i}:`, err.message);
      r = { hal_score: 0.5, decision: 'flagged' as any, signals: { error: err.message }, mode: 'extractor-fallback' };
    }
    const latency = Date.now() - start;
    const isCorrect = (c.expected_hallucination && r.decision === 'vetoed') ||
                      (!c.expected_hallucination && r.decision !== 'vetoed');
                      
    groqResults.push({
      testCaseId: c.id,
      expected: c.expected_hallucination,
      predictedScore: r.hal_score,
      predictedDecision: r.decision,
      correct: isCorrect,
      latencyMs: latency,
      signals: r.signals
    });
    
    process.stdout.write(`.`);
    if ((i + 1) % 25 === 0) console.log(` (${i + 1}/${cases.length})`);
    await delay(PACE_MS);
  }
  console.log();
  const groqMetrics = calculateMetrics(groqResults);
  console.log(`Groq Only F1: ${(groqMetrics.f1 * 100).toFixed(2)}%\n`);
  
  // 4. Evaluate Configuration C: Cerebras Only (strictness 2)
  console.log('--- Evaluating Cerebras Only (Strictness 2) ---');
  const cerebrasProviders = allProviders.filter(p => p.name === 'cerebras');
  const cerebrasService = new HalService(() => cerebrasProviders);
  const cerebrasResults: EvaluationResult[] = [];
  
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const start = Date.now();
    let r;
    try {
      r = await cerebrasService.evaluate({
        text: c.prompt_text,
        strictness: 2,
        context: { domain: 'general', certainty: 0.85 }
      });
    } catch (err: any) {
      console.error(`Error on item ${i}:`, err.message);
      r = { hal_score: 0.5, decision: 'flagged' as any, signals: { error: err.message }, mode: 'extractor-fallback' };
    }
    const latency = Date.now() - start;
    const isCorrect = (c.expected_hallucination && r.decision === 'vetoed') ||
                      (!c.expected_hallucination && r.decision !== 'vetoed');
                      
    cerebrasResults.push({
      testCaseId: c.id,
      expected: c.expected_hallucination,
      predictedScore: r.hal_score,
      predictedDecision: r.decision,
      correct: isCorrect,
      latencyMs: latency,
      signals: r.signals
    });
    
    process.stdout.write(`.`);
    if ((i + 1) % 25 === 0) console.log(` (${i + 1}/${cases.length})`);
    await delay(PACE_MS);
  }
  console.log();
  const cerebrasMetrics = calculateMetrics(cerebrasResults);
  console.log(`Cerebras Only F1: ${(cerebrasMetrics.f1 * 100).toFixed(2)}%\n`);
  
  // 5. Evaluate Configuration D: Full Quorum (Groq + Cerebras)
  console.log('--- Evaluating Full Quorum (Strictness 2) ---');
  const quorumService = new HalService(() => allProviders);
  const quorumResults: EvaluationResult[] = [];
  
  // We'll also save the runs for the Quorum run as our "official" validation run
  const insertPayloads: any[] = [];
  
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const start = Date.now();
    let r;
    try {
      r = await quorumService.evaluate({
        text: c.prompt_text,
        strictness: 2,
        context: { domain: 'general', certainty: 0.85 }
      });
    } catch (err: any) {
      console.error(`Error on item ${i}:`, err.message);
      r = { hal_score: 0.5, decision: 'flagged' as any, signals: { error: err.message }, mode: 'extractor-fallback' };
    }
    const latency = Date.now() - start;
    const isCorrect = (c.expected_hallucination && r.decision === 'vetoed') ||
                      (!c.expected_hallucination && r.decision !== 'vetoed');
                      
    quorumResults.push({
      testCaseId: c.id,
      expected: c.expected_hallucination,
      predictedScore: r.hal_score,
      predictedDecision: r.decision,
      correct: isCorrect,
      latencyMs: latency,
      signals: r.signals
    });
    
    insertPayloads.push({
      run_id: runId,
      test_case_id: c.id,
      hal_decision: r.decision,
      hal_score: r.hal_score,
      hal_signals: r.signals,
      correct: isCorrect,
      latency_ms: latency,
      model: allProviders.map(p => p.model).join(', '),
      provider: allProviders.map(p => p.name).join(', '),
      harness_version: '1.0.0'
    });
    
    process.stdout.write(`.`);
    if ((i + 1) % 25 === 0) console.log(` (${i + 1}/${cases.length})`);
    await delay(PACE_MS);
  }
  console.log();
  const quorumMetrics = calculateMetrics(quorumResults);
  console.log(`Full Quorum F1: ${(quorumMetrics.f1 * 100).toFixed(2)}%\n`);
  
  // 6. Save results to hal_external_validation_runs
  console.log('Saving quorum validation runs to database...');
  const { error: insertErr } = await db
    .from('hal_external_validation_runs')
    .insert(insertPayloads);
    
  if (insertErr) {
    console.error('Failed to save validation runs:', insertErr.message);
  } else {
    console.log(`Successfully saved ${insertPayloads.length} runs. Run ID: ${runId}`);
  }
  
  // 7. Print Sensitivity Table and Summary
  console.log('\n========================================================================');
  console.log('                    HAL ACCURACY & SENSITIVITY SUMMARY');
  console.log('========================================================================');
  console.log(`Date: ${new Date().toISOString().split('T')[0]}`);
  console.log(`Corpus Size: ${cases.length} provenanced external items`);
  console.log('------------------------------------------------------------------------');
  console.log('| Configuration             | F1 Score | Precision | Recall  | Accuracy |');
  console.log('------------------------------------------------------------------------');
  console.log(`| Extractor (Strictness 1)  | ${(extractorMetrics.f1*100).toFixed(1).padStart(7)}% | ${(extractorMetrics.precision*100).toFixed(1).padStart(8)}% | ${(extractorMetrics.recall*100).toFixed(1).padStart(6)}% | ${(extractorMetrics.accuracy*100).toFixed(1).padStart(7)}% |`);
  console.log(`| Groq-Only (Strictness 2)  | ${(groqMetrics.f1*100).toFixed(1).padStart(7)}% | ${(groqMetrics.precision*100).toFixed(1).padStart(8)}% | ${(groqMetrics.recall*100).toFixed(1).padStart(6)}% | ${(groqMetrics.accuracy*100).toFixed(1).padStart(7)}% |`);
  console.log(`| Cerebras-Only (Str. 2)    | ${(cerebrasMetrics.f1*100).toFixed(1).padStart(7)}% | ${(cerebrasMetrics.precision*100).toFixed(1).padStart(8)}% | ${(cerebrasMetrics.recall*100).toFixed(1).padStart(6)}% | ${(cerebrasMetrics.accuracy*100).toFixed(1).padStart(7)}% |`);
  console.log(`| Quorum (Str. 2, 2-of-2)   | ${(quorumMetrics.f1*100).toFixed(1).padStart(7)}% | ${(quorumMetrics.precision*100).toFixed(1).padStart(8)}% | ${(quorumMetrics.recall*100).toFixed(1).padStart(6)}% | ${(quorumMetrics.accuracy*100).toFixed(1).padStart(7)}% |`);
  console.log('========================================================================\n');
  
  // Break down Quorum F1 per dataset
  console.log('Quorum Performance per Dataset:');
  const datasets = [
    { name: 'TruthfulQA', filter: 'external-truthfulqa-20260606' },
    { name: 'FEVER', filter: 'external-fever-20260606' },
    { name: 'HaluEval', filter: 'external-halueval-20260606' }
  ];
  
  for (const ds of datasets) {
    const dsResults = quorumResults.filter((_, idx) => cases[idx]!.source === ds.filter);
    const dsMetrics = calculateMetrics(dsResults);
    console.log(`  - ${ds.name.padEnd(12)}: F1=${(dsMetrics.f1*100).toFixed(1)}% (TP=${dsMetrics.tp}, FP=${dsMetrics.fp}, TN=${dsMetrics.tn}, FN=${dsMetrics.fn})`);
  }
  
  // 8. Analyze Fail-safe (FPR under Quorum)
  const isQuorumMet = (res: EvaluationResult) => {
    // In our quorum service, since we have 2 providers, did both succeed?
    // signals.providers_used contains how many providers succeeded.
    const mode = res.signals?.hal_mode || res.signals?.error ? 'failed' : 'ok';
    const used = Number(res.signals?.providers_used || 0);
    return used >= 2;
  };
  
  const quorumUnavailableVetoes = quorumResults.filter((r, idx) => {
    const isVetoExpected = r.expected === true;
    const wouldVeto = r.predictedScore >= 0.5; // veto threshold is 0.5
    const hasQuorum = isQuorumMet(r);
    // If it would have vetoed but had no quorum, it was downgraded/neutralized to flagged/clean
    return wouldVeto && !hasQuorum;
  });
  
  console.log(`\nFail-safe mitigation:`);
  console.log(`  Items requiring quorum where veto was neutralized: ${quorumUnavailableVetoes.length}`);
  
  process.exit(0);
}

main().catch(e => {
  console.error('Fatal harness error:', e);
  process.exit(2);
});
