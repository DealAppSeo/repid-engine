import { db } from '../db';
import { halService } from '../hal/service';
import { buildFactCheckProviders } from '../hal/fact-check';
import crypto from 'crypto';

export interface RunMetrics {
  total: number;
  correct: number;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export interface DetailedResults {
  global: RunMetrics;
  byCategory: Record<string, RunMetrics>;
  byDifficulty: Record<string, RunMetrics>;
  calibration: {
    highConfidence: { total: number; correct: number; accuracy: number };
    mediumConfidence: { total: number; correct: number; accuracy: number };
    lowConfidence: { total: number; correct: number; accuracy: number };
  };
}

const HARNESS_VERSION = "1.0.0";
const PRIOR_F1_BASELINE = 0.6154; // 61.54% from previous Gemini one-off

function calculateMetrics(tp: number, fp: number, tn: number, fn: number): RunMetrics {
  const total = tp + fp + tn + fn;
  const correct = tp + tn;
  const accuracy = total > 0 ? correct / total : 0;
  const precision = (tp + fp) > 0 ? tp / (tp + fp) : 0;
  const recall = (tp + fn) > 0 ? tp / (tp + fn) : 0;
  const f1 = (precision + recall) > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

  return { total, correct, accuracy, precision, recall, f1, tp, fp, tn, fn };
}

export async function runValidationHarness(strictness: 1 | 2 = 1): Promise<DetailedResults> {
  console.log(`[HAL-Validation-Harness] Starting validation run (strictness: ${strictness})...`);
  const runId = crypto.randomUUID();

  // 1. Fetch all test cases
  const { data: testCases, error: fetchErr } = await db
    .from('hal_test_cases')
    .select('*')
    .order('created_at');

  if (fetchErr || !testCases || testCases.length === 0) {
    throw new Error(`Failed to load test cases: ${fetchErr?.message || 'Empty table'}`);
  }

  console.log(`Loaded ${testCases.length} test cases for evaluation.`);

  const runsToInsert: any[] = [];
  const resultsByCase: Array<{
    tc: any;
    halDecision: string;
    halScore: number;
    signals: any;
    correct: boolean;
    latency: number;
  }> = [];

  // 2. Blindly score each case
  for (const tc of testCases) {
    if (strictness === 2 && testCases.indexOf(tc) > 0) {
      await new Promise(resolve => setTimeout(resolve, 800));
    }

    const start = Date.now();
    
    // Evaluate using real HAL Service (Blind: HAL only gets prompt_text)
    const halRes = await halService.evaluate({
      text: tc.prompt_text,
      strictness
    });

    const latency = Date.now() - start;

    // Check correctness:
    // tc.expected_decision: 'pass' | 'veto'
    // halRes.decision: 'vetoed' | 'flagged' | 'clean'
    const isVetoed = halRes.decision === 'vetoed';
    const expectedVeto = tc.expected_decision === 'veto';
    const correct = isVetoed === expectedVeto;

    resultsByCase.push({
      tc,
      halDecision: halRes.decision,
      halScore: halRes.hal_score,
      signals: halRes.signals,
      correct,
      latency
    });

    const factCheckProviders = buildFactCheckProviders();
    const activeProviders = strictness === 2 && Array.isArray(halRes.provider_responses)
      ? halRes.provider_responses.filter((pr: any) => pr.verdict !== 'ERROR').map((pr: any) => pr.provider)
      : [];
    const activeModels = activeProviders.map(provName => {
      const matched = factCheckProviders.find(p => p.name === provName);
      return matched ? matched.model : 'unknown';
    });

    const providerName = activeProviders.length > 0 ? activeProviders.join(',') : String(halRes.signals?.provider || 'local-extractor');
    const modelName = activeModels.length > 0 ? activeModels.join(',') : String(halRes.signals?.model || 'local-extractor');

    runsToInsert.push({
      run_id: runId,
      test_case_id: tc.id,
      hal_decision: halRes.decision,
      hal_score: halRes.hal_score,
      hal_signals: { ...(halRes.signals || {}), verdicts: halRes.provider_responses },
      correct,
      latency_ms: latency,
      model: modelName,
      provider: providerName,
      harness_version: HARNESS_VERSION
    });
  }

  // Write runs to database
  const { error: insErr } = await db.from('hal_validation_runs').insert(runsToInsert);
  if (insErr) {
    console.error(`[HAL-Validation-Harness] Failed to write runs:`, insErr.message);
  }

  // 3. Aggregate metrics
  let gTp = 0, gFp = 0, gTn = 0, gFn = 0;
  const catCounts: Record<string, { tp: number; fp: number; tn: number; fn: number }> = {};
  const diffCounts: Record<string, { tp: number; fp: number; tn: number; fn: number }> = {};

  // Calibration counters
  let highTotal = 0, highCorrect = 0;
  let medTotal = 0, medCorrect = 0;
  let lowTotal = 0, lowCorrect = 0;

  for (const r of resultsByCase) {
    const expectedVeto = r.tc.expected_decision === 'veto';
    const predictedVeto = r.halDecision === 'vetoed';

    let tp = 0, fp = 0, tn = 0, fn = 0;
    if (expectedVeto && predictedVeto) { tp = 1; gTp++; }
    else if (!expectedVeto && predictedVeto) { fp = 1; gFp++; }
    else if (!expectedVeto && !predictedVeto) { tn = 1; gTn++; }
    else if (expectedVeto && !predictedVeto) { fn = 1; gFn++; }

    // Category tracking
    const cat = r.tc.category;
    if (!catCounts[cat]) catCounts[cat] = { tp: 0, fp: 0, tn: 0, fn: 0 };
    catCounts[cat].tp += tp;
    catCounts[cat].fp += fp;
    catCounts[cat].tn += tn;
    catCounts[cat].fn += fn;

    // Difficulty tracking
    const diff = r.tc.difficulty;
    if (!diffCounts[diff]) diffCounts[diff] = { tp: 0, fp: 0, tn: 0, fn: 0 };
    diffCounts[diff].tp += tp;
    diffCounts[diff].fp += fp;
    diffCounts[diff].tn += tn;
    diffCounts[diff].fn += fn;

    // Calibration: map hal score to confidence buckets
    // Score closer to 0 or 1 indicates high certainty (confidence in result)
    const certainty = r.signals?.certainty_at_claim ?? 0.8;
    if (certainty >= 0.9) {
      highTotal++;
      if (r.correct) highCorrect++;
    } else if (certainty >= 0.7) {
      medTotal++;
      if (r.correct) medCorrect++;
    } else {
      lowTotal++;
      if (r.correct) lowCorrect++;
    }
  }

  const globalMetrics = calculateMetrics(gTp, gFp, gTn, gFn);

  const byCategory: Record<string, RunMetrics> = {};
  for (const [cat, counts] of Object.entries(catCounts)) {
    byCategory[cat] = calculateMetrics(counts.tp, counts.fp, counts.tn, counts.fn);
  }

  const byDifficulty: Record<string, RunMetrics> = {};
  for (const [diff, counts] of Object.entries(diffCounts)) {
    byDifficulty[diff] = calculateMetrics(counts.tp, counts.fp, counts.tn, counts.fn);
  }

  const detailedResults: DetailedResults = {
    global: globalMetrics,
    byCategory,
    byDifficulty,
    calibration: {
      highConfidence: { total: highTotal, correct: highCorrect, accuracy: highTotal > 0 ? highCorrect / highTotal : 0 },
      mediumConfidence: { total: medTotal, correct: medCorrect, accuracy: medTotal > 0 ? medCorrect / medTotal : 0 },
      lowConfidence: { total: lowTotal, correct: lowCorrect, accuracy: lowTotal > 0 ? lowCorrect / lowTotal : 0 }
    }
  };

  // 4. Save to summaries table
  const { error: sumErr } = await db.from('hal_validation_summaries').insert({
    run_id: runId,
    total_cases: globalMetrics.total,
    correct_cases: globalMetrics.correct,
    accuracy: globalMetrics.accuracy,
    precision_score: globalMetrics.precision,
    recall_score: globalMetrics.recall,
    f1_score: globalMetrics.f1,
    false_positives: globalMetrics.fp,
    false_negatives: globalMetrics.fn,
    true_positives: globalMetrics.tp,
    true_negatives: globalMetrics.tn,
    by_category: byCategory,
    by_difficulty: byDifficulty,
    harness_version: HARNESS_VERSION
  });

  if (sumErr) {
    console.error(`[HAL-Validation-Harness] Failed to write summary:`, sumErr.message);
  }

  // 5. Check for regression
  await checkRegressions(globalMetrics.f1);

  return detailedResults;
}

async function checkRegressions(currentF1: number): Promise<void> {
  // Query previous validation summaries
  const { data, error } = await db
    .from('hal_validation_summaries')
    .select('f1_score')
    .order('run_at', { ascending: false })
    .limit(2); // Get latest including current

  let previousF1 = PRIOR_F1_BASELINE;
  if (!error && data && data.length > 1 && data[1]) {
    previousF1 = Number(data[1].f1_score ?? PRIOR_F1_BASELINE);
  }

  console.log(`\n=== REGRESSION CHECK ===`);
  console.log(`Current F1 Score:  ${(currentF1 * 100).toFixed(2)}%`);
  console.log(`Previous F1 Score: ${(previousF1 * 100).toFixed(2)}%`);

  if (currentF1 < previousF1) {
    const drop = ((previousF1 - currentF1) * 100).toFixed(2);
    console.warn(`\n[WARNING] REGRESSION DETECTED! F1 score dropped by ${drop}% from previous run/baseline.`);
  } else {
    console.log(`[OK] No regression detected. F1 score is stable or improved.`);
  }
  console.log(`========================\n`);
}
