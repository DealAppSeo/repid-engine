import { db } from '../../src/db';
import { HalService } from '../../src/hal/service';
import { buildFactCheckProviders } from '../../src/hal/fact-check';
import { evaluate } from '../../src/hal/lib/evaluate';
import * as crypto from 'crypto';
import { HalStrictness } from '../../src/hal/measurement-ruler';
import { caseFamilies, harnessWidth, loadRulerSelection, ruledReport, rulerFromArgv, rulerKey } from '../../src/hal/sealed-ruler';

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

const envTrue = (k: string) => /^(1|true|yes|on)$/i.test(process.env[k] ?? '');

async function main() {
  console.log('=== Starting HAL External Scoring Harness ===\n');
  
  // 1. The ruler's cases (default: the newest hal-sealed-v<N>; `--ruler` to pick another version).
  const sel = await loadRulerSelection(db, rulerFromArgv(), ['expected_decision', 'notes']);
  const cases = sel.rows as unknown as TestCase[];
  console.log(`Loaded ${cases.length} cases of ${sel.rulerId}@${sel.manifest.contentHash}.\n`);

  /** Every metric line carries the ruler id, hash and N, split public-benchmark vs internal. */
  const report = (label: string, rs: EvaluationResult[], strictness: HalStrictness, providers: { name: string; family?: string }[]) => {
    const width = harnessWidth({
      strictness,
      familiesConfigured: new Set(providers.map((p) => p.family ?? p.name)).size,
      perCaseFamilies: rs.map((r) => caseFamilies(strictness, r.signals)),
      decisionRequiresQuorum: envTrue('HAL_DECISION_REQUIRES_QUORUM'),
      penaltyRequiresQuorum: envTrue('HAL_PENALTY_REQUIRES_QUORUM'),
    });
    const rep = ruledReport(sel, rs.map((r) => ({ id: r.testCaseId, predictedHallucination: r.predictedDecision === 'vetoed' })), width);
    return { lines: [`--- ${label} ---`, ...rep.lines], overall: rep.overall };
  };
  const summary: string[] = [];

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
  summary.push(...report('Extractor (strictness 1)', extractorResults, 1, [{ name: 'local-extractor' }]).lines);
  
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
  summary.push(...report('Groq only (strictness 2)', groqResults, 2, groqProviders).lines);
  
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
  summary.push(...report('Cerebras only (strictness 2)', cerebrasResults, 2, cerebrasProviders).lines);
  
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
  const quorumReport = report('Full quorum (strictness 2)', quorumResults, 2, allProviders);
  summary.push(...quorumReport.lines);
  // The stored rows carry their ruler, so GET /hal/stats can cite it (or withhold the number).
  const rulerTag = `2.0.0|${rulerKey(quorumReport.overall.ruler)}`;
  for (const row of insertPayloads) row.harness_version = rulerTag;
  
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
  
  // 7. Summary: ruled lines only (the per-dataset table is the public-benchmark/internal split now).
  console.log('\n=== HAL ACCURACY & SENSITIVITY SUMMARY ===');
  for (const line of summary) console.log(line);

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
