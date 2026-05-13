/**
 * CC Sprint 7 — scaffolding for the 26 ground-truth labels.
 *
 * SCAFFOLDING ONLY — does NOT insert anything by default.
 *
 * Sean (or a future labeling sprint) fills in the LABELS array below
 * with the actual hal_runner_results.id values that correspond to
 * the 26 hand-crafted ground-truth prompts referenced in GMPD's
 * F1=0.86 claim, then runs:
 *
 *   npx ts-node scripts/seed-ground-truth-26-prompts.ts --run
 *
 * Without --run, the script prints what it WOULD insert and exits 0.
 *
 * Once ≥30 labels are in hal_ground_truth_labels, hal_accuracy_summary
 * starts returning meaningful F1/precision/recall numbers (data_quality
 * transitions from INSUFFICIENT_GROUND_TRUTH to OK).
 */

import 'dotenv/config';
import { db } from '../src/db';

interface GroundTruthLabel {
  source_id: string;             // hal_runner_results.id, cast to text
  is_hallucination: boolean;     // the truth-of-the-matter
  ground_truth_confidence: number; // 0..1
  rationale?: string;            // optional human-readable explanation
}

// ============================================================
// Sean fills this in. The 26 prompts referenced in GMPD's F1=0.86
// claim should map here. Each entry needs the hal_runner_results.id
// of the row that recorded the HAL evaluation for that prompt, plus
// the GROUND TRUTH (was the LLM output actually a hallucination?).
//
// To find candidate rows:
//   SELECT id, prompt_id, hal_score, hal_vetoed, generated_answer
//     FROM hal_runner_results
//     WHERE benchmark_source LIKE 'wave5%' OR benchmark_source LIKE 'internal-prompts%'
//     ORDER BY id
//     LIMIT 100;
// ============================================================
const LABELS: GroundTruthLabel[] = [
  // --- Example shape; replace with real 26 entries ---
  // {
  //   source_id: '12345',
  //   is_hallucination: true,
  //   ground_truth_confidence: 0.95,
  //   rationale: 'Claim about LA cap rate compression in 2024 — verified against CBRE Q4 2024 report; the 4.8% figure is fabricated.',
  // },
];

const LABELER = 'sean';  // change if a different labeler is running

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const isRun = args.includes('--run');

  console.log('--- seed-ground-truth-26-prompts ---');
  console.log(`Mode: ${isRun ? 'WRITE' : 'DRY-RUN'}`);
  console.log(`Labeler: ${LABELER}`);
  console.log(`Labels staged in this script: ${LABELS.length}`);

  if (LABELS.length === 0) {
    console.log('');
    console.log('⚠️  LABELS array is empty (template state).');
    console.log('   Edit this file: fill in the 26 hand-crafted ground-truth entries,');
    console.log('   then re-run with --run to insert them.');
    console.log('');
    console.log('   See script header for the SELECT query that finds candidate hal_runner_results rows.');
    return 0;
  }

  if (!isRun) {
    console.log('');
    console.log('DRY-RUN — would insert these rows:');
    for (const l of LABELS) {
      console.log(`  source_id=${l.source_id} is_hallucination=${l.is_hallucination} conf=${l.ground_truth_confidence} (${l.rationale ?? 'no rationale'})`);
    }
    console.log('');
    console.log('Re-run with --run to actually insert.');
    return 0;
  }

  console.log('');
  console.log('WRITE mode — inserting...');
  let inserted = 0;
  let skipped = 0;
  for (const l of LABELS) {
    const { error } = await db
      .from('hal_ground_truth_labels')
      .insert({
        source_table: 'hal_runner_results',
        source_id: l.source_id,
        is_hallucination: l.is_hallucination,
        ground_truth_confidence: l.ground_truth_confidence,
        labeled_by: LABELER,
        rationale: l.rationale ?? null,
      });
    if (error) {
      if (error.code === '23505') {
        console.log(`  source_id=${l.source_id}: SKIP (already labeled by ${LABELER})`);
        skipped++;
      } else {
        console.error(`  source_id=${l.source_id}: ERROR ${error.message}`);
      }
    } else {
      console.log(`  source_id=${l.source_id}: inserted (is_hallucination=${l.is_hallucination})`);
      inserted++;
    }
  }

  console.log('');
  console.log(`Done. inserted=${inserted} skipped=${skipped}`);
  console.log('');
  console.log('Verify the view picked them up:');
  console.log('  SELECT * FROM hal_accuracy_summary;');
  console.log('');
  console.log('Once total_labeled >= 30, data_quality transitions to OK and metrics become meaningful.');

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error('seed-ground-truth-26-prompts crashed:', e);
    process.exit(2);
  });
