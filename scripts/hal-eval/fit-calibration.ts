/**
 * fit-calibration.ts — fit the HAL confidence calibrator on the FROZEN holdout
 * and report ECE before and after.
 *
 * Reads only the measured holdout artifact. It makes no LLM calls: the run that
 * produced those scores already happened, is hash-pinned, and re-running it
 * would produce a slightly different corpus for no gain. Calibration is a
 * post-hoc fit on measurements, so it should be reproducible offline from the
 * artifact alone — a reviewer reruns this and gets the identical parameters.
 *
 * THE SELECTION RULE IS FIXED BEFORE THE NUMBERS ARE SEEN: both candidates are
 * fitted, and the winner is the one with lower OUT-OF-FOLD ECE. Not in-sample
 * ECE, which flatters the richer model by construction. Stating the rule up
 * front is what stops "we tried two and reported the better one" from being
 * indistinguishable from a result.
 *
 *   npx ts-node scripts/hal-eval/fit-calibration.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  fitCalibrator,
  applyCalibrator,
  expectedCalibrationError,
  crossValidatedEce,
  runDigest,
  type CalibrationMethod,
  type CalibrationSample,
} from '../../src/services/hal-calibration';

const HOLDOUT = join(__dirname, '../../reports/hal-eval/rigorous-v1-holdout-596f10de18d0.LOCAL.json');
const OUT = join(__dirname, '../../reports/hal-eval/hal-calibrator-rigorous-v1.json');

interface HoldoutRow {
  id: string;
  truth: 'TRUE' | 'FALSE';
  verdict: 'vetoed' | 'flagged' | 'clean';
  halScore: number;
}

function main(): void {
  if (!existsSync(HOLDOUT)) {
    // Refuse rather than fit on whatever happens to be lying around. A
    // calibrator with no ruler is worse than none: it is a number that looks
    // authoritative and describes nothing.
    console.error(`REFUSE: holdout artifact not found at ${HOLDOUT}`);
    process.exit(1);
  }

  const doc = JSON.parse(readFileSync(HOLDOUT, 'utf8'));
  const results: HoldoutRow[] = doc.results;
  const corpusSha256: string = doc.corpus_sha256;
  const ruler: string = doc.ruler;

  const samples: CalibrationSample[] = results.map((r) => ({
    rawScore: r.halScore,
    isPositive: r.truth === 'FALSE', // positive class = the claim really was a hallucination
  }));

  const before = expectedCalibrationError(samples.map((s) => ({ p: s.rawScore, isPositive: s.isPositive })));

  console.log('');
  console.log('HAL CONFIDENCE CALIBRATION — post-hoc logit scaling');
  console.log(`  ruler         : ${ruler} @ ${corpusSha256.slice(0, 12)}`);
  console.log(`  n             : ${samples.length} (${samples.filter((s) => s.isPositive).length} hallucinations)`);
  console.log('');
  console.log(`  ECE BEFORE    : ${before.ece.toFixed(4)}   (max single-bin gap ${before.maxGap.toFixed(4)})`);
  console.log('');
  console.log('  CANDIDATES — selected on OUT-OF-FOLD ECE, rule fixed before fitting:');

  const candidates: { method: CalibrationMethod; cal: ReturnType<typeof fitCalibrator>; oof5: number; oof10: number; maxGap: number }[] = [];
  for (const method of ['temperature', 'platt'] as CalibrationMethod[]) {
    const cal = fitCalibrator(samples, { ruler, corpusSha256, method });
    const cv5 = crossValidatedEce(samples, 5, 10, method);
    const cv10 = crossValidatedEce(samples, 10, 10, method);
    const inSample = expectedCalibrationError(
      samples.map((s) => ({ p: applyCalibrator(s.rawScore, cal), isPositive: s.isPositive })),
    );
    candidates.push({ method, cal, oof5: cv5.ece.ece, oof10: cv10.ece.ece, maxGap: cv5.ece.maxGap });
    console.log(
      `    ${method.padEnd(11)} T=${cal.temperature.toFixed(4)} bias=${cal.bias.toFixed(4)}  ` +
        `nll=${cal.nll.toFixed(4)}  in-sample ECE=${inSample.ece.toFixed(4)}  ` +
        `OOF-5=${cv5.ece.ece.toFixed(4)}  OOF-10=${cv10.ece.ece.toFixed(4)}`,
    );
  }

  const winner = candidates.reduce((a, b) => (b.oof5 < a.oof5 ? b : a));
  const cal = winner.cal;
  const after = expectedCalibrationError(
    samples.map((s) => ({ p: applyCalibrator(s.rawScore, cal), isPositive: s.isPositive })),
  );
  const cv = crossValidatedEce(samples, 5, 10, winner.method);

  // ── THE GUARANTEE: no verdict moved ───────────────────────────────────────
  // The transform is monotone, so the confusion matrix must be identical.
  // Recomputed rather than asserted, because "monotone therefore unchanged" is
  // exactly the kind of reasoning that stays true until an off-by-one in a
  // threshold quietly makes it false.
  const THRESH = 0.5;
  const confusionAt = (p: (r: HoldoutRow) => number) => {
    let tp = 0, fp = 0, tn = 0, fn = 0;
    for (const r of results) {
      const pred = p(r) >= THRESH;
      const act = r.truth === 'FALSE';
      if (pred && act) tp++;
      else if (pred && !act) fp++;
      else if (!pred && !act) tn++;
      else fn++;
    }
    const prec = tp / Math.max(1, tp + fp);
    const rec = tp / Math.max(1, tp + fn);
    return { tp, fp, tn, fn, f1: (2 * prec * rec) / Math.max(1e-12, prec + rec) };
  };
  const cBefore = confusionAt((r) => r.halScore);
  const cAfterRanking = confusionAt((r) => applyCalibrator(r.halScore, { scale: cal.scale, bias: 0 }));
  const cAfter = confusionAt((r) => applyCalibrator(r.halScore, cal));
  // Ranking is what must be preserved. A bias term SHIFTS every probability, so
  // it can legitimately move cases across a fixed 0.5 cut without reordering
  // any pair — which is why the ranking check uses bias=0 and the operational
  // verdict keeps coming from HAL's own verdict field, never from a threshold
  // re-applied to a calibrated probability.
  const rankingPreserved = JSON.stringify(cBefore) === JSON.stringify(cAfterRanking);

  console.log('');
  console.log(`  SELECTED      : ${winner.method}  T=${cal.temperature.toFixed(4)}  bias=${cal.bias.toFixed(4)}`);
  console.log(`                  ${cal.temperature < 1 ? 'T<1: sharpening — raw score was UNDER-confident' : 'T>1: softening — raw score was OVER-confident'}`);
  console.log('');
  console.log(`  ECE before    : ${before.ece.toFixed(4)}   (max gap ${before.maxGap.toFixed(4)})`);
  console.log(`  ECE after     : ${after.ece.toFixed(4)}   (max gap ${after.maxGap.toFixed(4)})  [in-sample — optimistic by construction]`);
  console.log(`  ECE after     : ${cv.ece.ece.toFixed(4)}   (max gap ${cv.ece.maxGap.toFixed(4)})  [5-fold OUT-OF-FOLD — the honest number]`);
  const rel = ((before.ece - cv.ece.ece) / Math.max(1e-12, before.ece)) * 100;
  console.log(`  improvement   : ${rel.toFixed(1)}% ${rel >= 0 ? 'reduction' : 'INCREASE'} in out-of-fold ECE`);
  console.log(`  fold params   : T=[${cv.temperatures.map((t) => t.toFixed(3)).join(', ')}] bias=[${cv.biases.map((b) => b.toFixed(3)).join(', ')}]`);
  console.log('');
  console.log(`  RANKING PRESERVED (no verdict reordered): ${rankingPreserved ? 'YES' : 'NO — THIS IS A RETUNE, NOT A CALIBRATION'}`);
  console.log(`    before      tp=${cBefore.tp} fp=${cBefore.fp} tn=${cBefore.tn} fn=${cBefore.fn}  F1=${cBefore.f1.toFixed(4)}`);
  console.log(`    scale-only  tp=${cAfterRanking.tp} fp=${cAfterRanking.fp} tn=${cAfterRanking.tn} fn=${cAfterRanking.fn}  F1=${cAfterRanking.f1.toFixed(4)}`);
  console.log(`    with bias   tp=${cAfter.tp} fp=${cAfter.fp} tn=${cAfter.tn} fn=${cAfter.fn}  F1=${cAfter.f1.toFixed(4)}  (informational — verdicts come from HAL, not from re-thresholding this)`);
  console.log('');
  console.log('  RELIABILITY (raw -> calibrated), populated bins only:');
  for (let i = 0; i < before.bins.length; i++) {
    const b = before.bins[i]!;
    const a = after.bins[i]!;
    if (b.count === 0 && a.count === 0) continue;
    console.log(
      `    [${b.lo.toFixed(1)},${b.hi.toFixed(1)})  raw n=${String(b.count).padStart(2)} pred=${b.meanConfidence.toFixed(2)} obs=${b.observedRate.toFixed(2)} gap=${b.gap.toFixed(2)}` +
        `   |  cal n=${String(a.count).padStart(2)} pred=${a.meanConfidence.toFixed(2)} obs=${a.observedRate.toFixed(2)} gap=${a.gap.toFixed(2)}`,
    );
  }
  console.log('');

  if (!rankingPreserved) {
    console.error('REFUSE: calibration reordered a case. That is a retune, not a calibration. Not writing the artifact.');
    process.exit(1);
  }

  writeFileSync(
    OUT,
    JSON.stringify(
      {
        ...cal,
        // Binds this calibrator to the exact RUN it was fitted on, not merely
        // to the corpus. Without it, a refreshed holdout leaves a stale
        // calibrator sitting beside it looking perfectly valid.
        runDigest: runDigest(results),
        clip_eps: 1e-3,
        selection_rule: 'lowest 5-fold out-of-fold ECE; rule fixed before fitting',
        candidates: candidates.map((c) => ({
          method: c.method,
          temperature: c.cal.temperature,
          bias: c.cal.bias,
          oof5: c.oof5,
          oof10: c.oof10,
        })),
        ece_before: before.ece,
        ece_after_in_sample: after.ece,
        ece_after_out_of_fold: cv.ece.ece,
        max_gap_before: before.maxGap,
        max_gap_after_out_of_fold: cv.ece.maxGap,
        cv_folds: 5,
        cv_temperatures: cv.temperatures,
        cv_biases: cv.biases,
        ranking_preserved: rankingPreserved,
        confusion_before: cBefore,
        confusion_scale_only: cAfterRanking,
      },
      null,
      2,
    ),
  );
  console.log(`  frozen calibrator -> ${OUT}`);
}

main();
