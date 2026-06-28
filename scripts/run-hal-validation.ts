import { runValidationHarness } from '../src/services/hal-validation-runner';
import { db } from '../src/db';

async function main() {
  // Force strict mode for every harness run so silent degradations (missing
  // provider, classifier timeout, extractor failure) become loud, immediate
  // failures — we never measure a degraded pipeline and call it a baseline.
  // Production is unaffected: this only sets the env in this CLI process.
  process.env.HAL_STRICT_MODE = 'true';
  console.log('[harness] HAL_STRICT_MODE=true — degradations will fail loudly');

  const strictnessArg = process.argv[2];
  const strictness: 1 | 2 = strictnessArg === '2' ? 2 : 1;

  try {
    const results = await runValidationHarness(strictness);

    console.log(`\n======================================================`);
    console.log(`            HAL VALIDATION RUN SUMMARY (Strictness: ${strictness})`);
    console.log(`======================================================`);
    console.log(`Total Cases Evaluated:   ${results.global.total}`);
    console.log(`Correct Classifications: ${results.global.correct}`);
    console.log(`Accuracy:                ${(results.global.accuracy * 100).toFixed(2)}%`);
    console.log(`Precision:               ${(results.global.precision * 100).toFixed(2)}%`);
    console.log(`Recall:                  ${(results.global.recall * 100).toFixed(2)}%`);
    console.log(`F1 Score:                ${(results.global.f1 * 100).toFixed(2)}%`);
    console.log(`------------------------------------------------------`);
    console.log(`CONFUSION MATRIX:`);
    console.log(`  True Positives (TP):  ${results.global.tp} (Hallucinations Vetoed)`);
    console.log(`  True Negatives (TN):  ${results.global.tn} (Good Content Passed)`);
    console.log(`  False Positives (FP): ${results.global.fp} (Good Content Vetoed)`);
    console.log(`  False Negatives (FN): ${results.global.fn} (Hallucinations Passed)`);
    console.log(`======================================================\n`);

    console.log(`CATEGORY BREAKDOWN:`);
    console.table(
      Object.entries(results.byCategory).map(([cat, m]) => ({
        Category: cat,
        Total: m.total,
        Accuracy: `${(m.accuracy * 100).toFixed(1)}%`,
        Precision: `${(m.precision * 100).toFixed(1)}%`,
        Recall: `${(m.recall * 100).toFixed(1)}%`,
        F1: `${(m.f1 * 100).toFixed(1)}%`,
        FN: m.fn,
        FP: m.fp
      }))
    );

    console.log(`\nDIFFICULTY BREAKDOWN:`);
    console.table(
      Object.entries(results.byDifficulty).map(([diff, m]) => ({
        Difficulty: diff,
        Total: m.total,
        Accuracy: `${(m.accuracy * 100).toFixed(1)}%`,
        Precision: `${(m.precision * 100).toFixed(1)}%`,
        Recall: `${(m.recall * 100).toFixed(1)}%`,
        F1: `${(m.f1 * 100).toFixed(1)}%`
      }))
    );

    console.log(`\nCALIBRATION ANALYSIS (By Agent Stated Certainty):`);
    console.table([
      {
        ConfidenceBucket: "High (>= 90%)",
        TotalCases: results.calibration.highConfidence.total,
        CorrectCases: results.calibration.highConfidence.correct,
        Accuracy: `${(results.calibration.highConfidence.accuracy * 100).toFixed(1)}%`
      },
      {
        ConfidenceBucket: "Medium (70% - 89%)",
        TotalCases: results.calibration.mediumConfidence.total,
        CorrectCases: results.calibration.mediumConfidence.correct,
        Accuracy: `${(results.calibration.mediumConfidence.accuracy * 100).toFixed(1)}%`
      },
      {
        ConfidenceBucket: "Low (< 70%)",
        TotalCases: results.calibration.lowConfidence.total,
        CorrectCases: results.calibration.lowConfidence.correct,
        Accuracy: `${(results.calibration.lowConfidence.accuracy * 100).toFixed(1)}%`
      }
    ]);

    // Fetch the 5 most recent False Negatives (hallucinations passed) to print for analysis
    const { data: runs, error } = await db
      .from('hal_validation_runs')
      .select('test_case_id, hal_score, hal_decision, hal_signals, hal_test_cases(prompt_text, category, notes)')
      .eq('correct', false)
      .order('run_at', { ascending: false });

    if (!error && runs && runs.length > 0) {
      // Filter for actual False Negatives: expected_decision was veto (expected_hallucination=true) but hal_decision was not vetoed.
      const falseNegatives = runs.filter((r: any) => r.hal_decision !== 'vetoed');
      
      if (falseNegatives.length > 0) {
        console.log(`\n======================================================`);
        console.log(`          FALSE NEGATIVES EXAMPLES (HAL MISSED)`);
        console.log(`======================================================`);
        falseNegatives.slice(0, 5).forEach((fn: any, idx: number) => {
          console.log(`\n[${idx + 1}] Category: ${fn.hal_test_cases?.category || 'unknown'}`);
          console.log(`Prompt: "${fn.hal_test_cases?.prompt_text}"`);
          console.log(`HAL Score: ${fn.hal_score} (Decision: ${fn.hal_decision})`);
          console.log(`Signals: ${JSON.stringify(fn.hal_signals)}`);
          console.log(`Notes: ${fn.hal_test_cases?.notes || 'none'}`);
        });
        console.log(`======================================================\n`);
      }
    }

    process.exit(0);
  } catch (e: any) {
    console.error(`Validation harness failed:`, e.message);
    process.exit(1);
  }
}

main();
