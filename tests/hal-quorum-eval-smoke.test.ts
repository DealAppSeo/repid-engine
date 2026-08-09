/**
 * hal-quorum-eval-smoke.test.ts — pins the MACHINERY of the reproducible HAL
 * quorum evaluator (scripts/hal-eval/run-frozen-corpus-local.ts), NOT the F1 it
 * measures.
 *
 * The measured F1/AUC on the frozen corpus is DATA: it depends on live LLM
 * providers and legitimately moves run to run (LLM nondeterminism + which free
 * tiers rate-limit). Asserting a specific F1 here would be asserting a
 * measurement, which CLAUDE_RULES 24 forbids. What this test pins instead is the
 * deterministic code that turns (label, verdict, score) into a confusion matrix,
 * precision/recall/F1 and ROC AUC — the same functions the runner imports, so a
 * green test means the ruler's arithmetic is trustworthy even though the number
 * it produces is not fixed.
 *
 * Reference measurement (for the human reading this, not asserted):
 *   F1 ≈ 0.90, AUC ≈ 0.975 on rigorous-v1@596f10de18d0 [holdout], strictness 2,
 *   in-process ≥3-disjoint-family quorum. Contrast the extractor-only AUC 0.558
 *   (PR #393): the real cross-LLM quorum is far more discriminative than the
 *   style-extractor fallback. Reproduce with:
 *     npx ts-node scripts/hal-eval/run-frozen-corpus-local.ts --split holdout
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isHallucination, predictedHallucination, confusionMatrix, prf1, rocAuc } from '../scripts/hal-eval/metrics';

describe('HAL quorum eval — harness machinery (deterministic, no provider calls)', () => {
  it('the reproducible runner and its metrics module are present on disk', () => {
    const root = join(__dirname, '..');
    expect(existsSync(join(root, 'scripts', 'hal-eval', 'run-frozen-corpus-local.ts'))).toBe(true);
    expect(existsSync(join(root, 'scripts', 'hal-eval', 'metrics.ts'))).toBe(true);
  });

  describe('label + verdict mapping (positive class = hallucination)', () => {
    it('a FALSE-labelled row is a hallucination; TRUE is not (case-insensitive)', () => {
      expect(isHallucination('FALSE')).toBe(true);
      expect(isHallucination('false')).toBe(true);
      expect(isHallucination('TRUE')).toBe(false);
      expect(isHallucination('true')).toBe(false);
    });

    it("only a 'vetoed' HAL decision is a positive prediction", () => {
      expect(predictedHallucination('vetoed')).toBe(true);
      expect(predictedHallucination('clean')).toBe(false);
      expect(predictedHallucination('flagged')).toBe(false);
      expect(predictedHallucination('abstain')).toBe(false);
      expect(predictedHallucination(undefined)).toBe(false);
    });
  });

  describe('confusion matrix + P/R/F1 (synthetic rows — no real corpus, no providers)', () => {
    it('counts TP/FP/TN/FN with the positive=hallucination convention', () => {
      const c = confusionMatrix([
        { truth: 'FALSE', verdict: 'vetoed' }, // hallucination caught -> TP
        { truth: 'FALSE', verdict: 'clean' }, //  hallucination missed -> FN
        { truth: 'TRUE', verdict: 'vetoed' }, //  truth wrongly vetoed -> FP
        { truth: 'TRUE', verdict: 'clean' }, //   truth passed -> TN
        { truth: 'TRUE', verdict: 'flagged' }, // flagged is not a veto -> TN
      ]);
      expect(c).toEqual({ tp: 1, fp: 1, tn: 2, fn: 1 });
    });

    it('a perfect classifier scores F1 1.0; an all-clean classifier scores F1 0', () => {
      const perfect = prf1(confusionMatrix([
        { truth: 'FALSE', verdict: 'vetoed' },
        { truth: 'TRUE', verdict: 'clean' },
      ]));
      expect(perfect.f1).toBeCloseTo(1.0, 10);
      expect(perfect.precision).toBeCloseTo(1.0, 10);
      expect(perfect.recall).toBeCloseTo(1.0, 10);

      const allClean = prf1(confusionMatrix([
        { truth: 'FALSE', verdict: 'clean' },
        { truth: 'TRUE', verdict: 'clean' },
      ]));
      expect(allClean.f1).toBe(0); // no true positives -> F1 0, not NaN
    });

    it('reproduces the F1 formula on a known 2x2 matrix', () => {
      // tp=43 fp=5 tn=46 fn=5 -> precision=recall=43/48 -> F1=43/48
      const m = prf1({ tp: 43, fp: 5, tn: 46, fn: 5 });
      expect(m.precision).toBeCloseTo(43 / 48, 12);
      expect(m.recall).toBeCloseTo(43 / 48, 12);
      expect(m.f1).toBeCloseTo(43 / 48, 12);
      expect(m.accuracy).toBeCloseTo(89 / 99, 12);
    });
  });

  describe('ROC AUC (tie-aware Mann–Whitney U)', () => {
    it('perfect score separation -> AUC 1.0', () => {
      const auc = rocAuc([
        { score: 0.9, positive: true },
        { score: 0.8, positive: true },
        { score: 0.2, positive: false },
        { score: 0.1, positive: false },
      ]);
      expect(auc).toBeCloseTo(1.0, 12);
    });

    it('inverted ranking -> AUC 0.0', () => {
      const auc = rocAuc([
        { score: 0.1, positive: true },
        { score: 0.2, positive: true },
        { score: 0.8, positive: false },
        { score: 0.9, positive: false },
      ]);
      expect(auc).toBeCloseTo(0.0, 12);
    });

    it('all-equal scores -> AUC exactly 0.5 (ties do not inflate)', () => {
      const auc = rocAuc([
        { score: 0.5, positive: true },
        { score: 0.5, positive: false },
        { score: 0.5, positive: true },
        { score: 0.5, positive: false },
      ]);
      expect(auc).toBeCloseTo(0.5, 12);
    });

    it('a single-class set has undefined AUC (null, not a fabricated number)', () => {
      expect(rocAuc([{ score: 0.9, positive: true }, { score: 0.8, positive: true }])).toBeNull();
      expect(rocAuc([{ score: 0.1, positive: false }])).toBeNull();
    });
  });
});
