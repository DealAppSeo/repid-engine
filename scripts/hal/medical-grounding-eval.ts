/**
 * medical-grounding-eval.ts — a MEASUREMENT of the proof-carrying abstain mechanism on a
 * curated, real-sourced set of medical-guidance-change fixtures (tests/hal/medical-grounding/cases.ts).
 *
 * It extends the pattern of scripts/demo/proof-carrying-e2e.ts (RULE-10 — don't reinvent):
 * per case, COMMIT a guidance entry -> the proof-carrying agent BINDS a grounded answer citing it ->
 * the record is updated (superseded cases are REVOKED; controls are left intact) -> ASK AGAIN.
 *
 *   Proof-carrying agent  = emitGroundedAnswer(): ABSTAINS (throws) if a cited entry is no longer a
 *                           current member of memory. Should abstain on superseded cases, NOT on controls.
 *   Naive baseline        = keeps its original stored answer and re-asserts it. Re-verifying that stale
 *                           answer against the new root shows grounded=false — but the naive agent answers
 *                           anyway. That is the hallucination.
 *
 * Positive class = "should abstain after the record is updated". We report the proof-carrying agent's
 * abstention precision / recall / F1, its false-abstention rate on the still-valid controls (target 0),
 * and the naive baseline's hallucination rate on the superseded cases.
 *
 * Pure crypto (real Poseidon2, the default injected hashes) — no network, no DB, no mocking.
 *   npx tsx scripts/hal/medical-grounding-eval.ts
 * (If src/config.ts is pulled in and complains, export dummy SUPABASE_URL / SUPABASE_SERVICE_KEY;
 *  this script itself imports only the pure memory + hal-grounding modules.)
 */
import { ProofCarryingMemory, verifyProofCarryingAnswer, emitGroundedAnswer } from '../../src/memory/proof-carrying-memory';
import { computeGroundingSignal } from '../../src/hal/hal-grounding';
import { MEDICAL_GROUNDING_CASES, type MedicalGroundingCase } from '../../tests/hal/medical-grounding/cases';

export interface CaseOutcome {
  id: string;
  category: MedicalGroundingCase['category'];
  shouldAbstainAfterUpdate: boolean;
  /** The proof-carrying answer verified BEFORE the record was updated (must be true for every case). */
  groundedBeforeUpdate: boolean;
  /** Did the proof-carrying agent abstain when asked again after the record update? */
  pcAbstainedAfterUpdate: boolean;
  pcAbstainReason: string;
  /** HAL shadow-mode signal on the (now-stale) bound answer re-checked against the current root. */
  halWouldAbstain: boolean;
  /** The naive baseline always re-asserts; is that re-assertion still grounded against the new root? */
  naiveAnswerGroundedAfterUpdate: boolean;
  /** Naive re-asserted an answer that no longer verifies → a hallucination (only possible on positives). */
  naiveHallucinated: boolean;
}

/** Run one case through the full commit → ground → update → re-ask loop. Pure + synchronous. */
export function runCase(c: MedicalGroundingCase): CaseOutcome {
  const pcm = new ProofCarryingMemory();
  const v = pcm.add({
    content: c.guidance,
    source_id: 'guideline-registry',
    source_repid: 1800,
    hal_verdict: 'clean',
    epoch: 1,
  });

  // The proof-carrying agent binds a grounded answer citing the committed guidance.
  const answer = `Per the record: ${c.guidance}`;
  const pca = emitGroundedAnswer(answer, pcm, [v]);
  const groundedBeforeUpdate = verifyProofCarryingAnswer(pca).grounded;

  // The record is updated. Superseded/reversed guidance is REVOKED (provably retracted);
  // still-valid controls are left intact.
  if (c.shouldAbstainAfterUpdate) pcm.revoke(v);

  // Ask again — the proof-carrying agent re-derives from memory and abstains if the citation is stale.
  let pcAbstainedAfterUpdate = false;
  let pcAbstainReason = '';
  try {
    emitGroundedAnswer(answer, pcm, [v]);
  } catch (e) {
    pcAbstainedAfterUpdate = true;
    pcAbstainReason = e instanceof Error ? e.message : String(e);
  }

  // The naive baseline keeps its original bound answer and re-asserts it. Re-verify it at the current root.
  const staleAtCurrentRoot = { ...pca, memory_root: pcm.root() };
  const naiveAnswerGroundedAfterUpdate = verifyProofCarryingAnswer(staleAtCurrentRoot).grounded;
  const halWouldAbstain = computeGroundingSignal({ proof_carrying_answer: staleAtCurrentRoot }, 'shadow').would_abstain;
  const naiveHallucinated = !naiveAnswerGroundedAfterUpdate; // naive always answers; ungrounded answer = hallucination

  return {
    id: c.id,
    category: c.category,
    shouldAbstainAfterUpdate: c.shouldAbstainAfterUpdate,
    groundedBeforeUpdate,
    pcAbstainedAfterUpdate,
    pcAbstainReason,
    halWouldAbstain,
    naiveAnswerGroundedAfterUpdate,
    naiveHallucinated,
  };
}

export interface EvalMetrics {
  n: number;
  positives: number;
  controls: number;
  tp: number; fp: number; fn: number; tn: number;
  precision: number;
  recall: number;
  f1: number;
  falseAbstentionRateOnControls: number;
  naiveHallucinationRateOnPositives: number;
  allGroundedBeforeUpdate: boolean;
}

export function evaluate(outcomes: CaseOutcome[]): EvalMetrics {
  const positives = outcomes.filter((o) => o.shouldAbstainAfterUpdate);
  const controls = outcomes.filter((o) => !o.shouldAbstainAfterUpdate);
  const tp = positives.filter((o) => o.pcAbstainedAfterUpdate).length;
  const fn = positives.filter((o) => !o.pcAbstainedAfterUpdate).length;
  const fp = controls.filter((o) => o.pcAbstainedAfterUpdate).length;
  const tn = controls.filter((o) => !o.pcAbstainedAfterUpdate).length;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    n: outcomes.length,
    positives: positives.length,
    controls: controls.length,
    tp, fp, fn, tn,
    precision, recall, f1,
    falseAbstentionRateOnControls: controls.length === 0 ? 0 : fp / controls.length,
    naiveHallucinationRateOnPositives:
      positives.length === 0 ? 0 : positives.filter((o) => o.naiveHallucinated).length / positives.length,
    allGroundedBeforeUpdate: outcomes.every((o) => o.groundedBeforeUpdate),
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function main(): number {
  const outcomes = MEDICAL_GROUNDING_CASES.map(runCase);
  const m = evaluate(outcomes);

  console.log('\n════════ HAL medical-flavored grounding / abstention eval ════════');
  console.log('Fixtures: illustrative, historical/bibliographic — NOT medical advice. Real crypto (Poseidon2), no network.\n');

  console.log('Per-case outcome:');
  console.log('  id                                  category                          truth      PC       naive');
  for (const o of outcomes) {
    const truth = o.shouldAbstainAfterUpdate ? 'ABSTAIN' : 'ANSWER ';
    const pc = o.pcAbstainedAfterUpdate ? 'ABSTAIN' : 'ANSWER ';
    const naive = o.naiveHallucinated ? 'HALLUC.' : 'ok     ';
    const ok = (o.shouldAbstainAfterUpdate === o.pcAbstainedAfterUpdate) && o.groundedBeforeUpdate;
    console.log(`  ${(ok ? '✅' : '❌')} ${o.id.padEnd(34)} ${o.category.padEnd(32)} ${truth}   ${pc}  ${naive}`);
  }

  console.log('\nProof-carrying agent — abstention (positive class = "should abstain after update"):');
  console.log(`  TP=${m.tp}  FP=${m.fp}  FN=${m.fn}  TN=${m.tn}   (positives=${m.positives}, controls=${m.controls}, n=${m.n})`);
  console.log(`  precision = ${m.precision.toFixed(3)}   recall = ${m.recall.toFixed(3)}   F1 = ${m.f1.toFixed(3)}`);
  console.log(`  false-abstention rate on still-valid controls = ${pct(m.falseAbstentionRateOnControls)}  (target 0%)`);
  console.log(`  every answer grounded BEFORE the record update = ${m.allGroundedBeforeUpdate}`);
  console.log('\nNaive baseline (no proofs, re-asserts its stored answer):');
  console.log(`  hallucination rate on superseded cases = ${pct(m.naiveHallucinationRateOnPositives)}  (re-asserts a now-ungrounded answer)`);

  // The eval "passes" iff the mechanism behaved as designed on this fixture set:
  // perfect separation (abstain on all superseded, none on controls) and grounded-before for all.
  const pass =
    m.allGroundedBeforeUpdate &&
    m.f1 === 1 &&
    m.falseAbstentionRateOnControls === 0 &&
    m.naiveHallucinationRateOnPositives === 1;
  console.log(`\n${pass ? '════════ MECHANISM EVAL: PASS ════════' : '════════ MECHANISM EVAL: DID NOT MEET EXPECTED SEPARATION ════════'}`);
  console.log('(This is a mechanism eval on curated fixtures — NOT a live-traffic F1. See the report for limitations.)\n');
  return pass ? 0 : 1;
}

if (require.main === module) {
  process.exit(main());
}
