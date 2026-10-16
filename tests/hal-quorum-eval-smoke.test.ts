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
 *   style-extractor fallback. That split has been public since July and was retired
 *   as a holdout on 2026-10-07 (S60), so this is no longer a holdout number.
 *   Reproduce it with:
 *     npx ts-node scripts/hal-eval/run-frozen-corpus-local.ts --split retired-holdout
 *   (`--split holdout` now reads the private holdout: eval/holdout/README.md.)
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  isHallucination,
  predictedHallucination,
  confusionMatrix,
  prf1,
  rocAuc,
  isNotChecked,
  perClass,
  evalOrder,
  isNoAgreementVeto,
  isNotCheckedV2,
  isNotCheckedV3,
  isUnderQuorum,
  SCORING,
} from '../scripts/hal-eval/metrics';

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

  describe('NOT_CHECKED, per-class scores and the budget order', () => {
    it('an error, an abstain, a missing verdict or a non-fact-check mode is NOT_CHECKED', () => {
      expect(isNotChecked({ error: 'HTTP 429' })).toBe(true);
      expect(isNotChecked({ verdict: 'abstain', mode: 'fact-check' })).toBe(true);
      expect(isNotChecked({ verdict: 'clean', mode: 'extractor-fallback' })).toBe(true);
      expect(isNotChecked({})).toBe(true);
      expect(isNotChecked({ verdict: 'clean', mode: 'fact-check' })).toBe(false);
      expect(isNotChecked({ verdict: 'vetoed', mode: 'fact-check' })).toBe(false);
    });

    it('scores both classes from one confusion matrix', () => {
      // hallucination: 3 caught, 1 missed, 2 true claims wrongly vetoed. supported: the mirror.
      const { hallucination, supported } = perClass({ tp: 3, fn: 1, fp: 2, tn: 4 });
      expect(hallucination).toEqual({ precision: 3 / 5, recall: 3 / 4, f1: expect.any(Number), support: 4 });
      expect(hallucination.f1).toBeCloseTo((2 * 0.6 * 0.75) / 1.35, 12);
      expect(supported).toEqual({ precision: 4 / 5, recall: 4 / 6, f1: expect.any(Number), support: 6 });
      expect(perClass({ tp: 0, fp: 0, tn: 0, fn: 0 }).supported).toEqual({ precision: 0, recall: 0, f1: 0, support: 0 });
    });

    it('evalOrder is content-defined and keeps every prefix within one row of class balance', () => {
      const rows = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, label: i % 4 === 0 ? 'FALSE' : 'TRUE' }));
      const a = evalOrder(rows);
      expect(evalOrder([...rows].reverse())).toEqual(a); // file order cannot move it
      expect(a).toHaveLength(40);
      expect(new Set(a.map((r) => r.id)).size).toBe(40);
      for (let k = 1; k <= 20; k++) {
        const pos = a.slice(0, k).filter((r) => r.label === 'FALSE').length;
        expect(Math.abs(pos - (k - pos))).toBeLessThanOrEqual(1); // 10 FALSE rows: balanced until they run out
      }
    });
  });

  describe('scoring v2: a veto no checker voted FALSE for is NOT_CHECKED', () => {
    it('names itself, so outputs on different scorings cannot be mixed up', () => {
      expect(SCORING).toBe('v3-two-families-or-not-checked');
    });

    it('two UNCERTAIN votes behind a veto is not a catch; one FALSE vote is', () => {
      const uncertain = { verdict: 'vetoed', mode: 'fact-check', votes: { UNCERTAIN: 2, ERROR: 5 } };
      expect(isNoAgreementVeto(uncertain)).toBe(true);
      expect(isNotCheckedV2(uncertain)).toBe(true);
      const caught = { verdict: 'vetoed', mode: 'fact-check', votes: { FALSE: 2 } };
      expect(isNotCheckedV2(caught)).toBe(false);
      expect(isNotCheckedV2({ verdict: 'vetoed', mode: 'fact-check', votes: { FALSE: 1, UNCERTAIN: 1 } })).toBe(false);
    });

    it('a veto with no recorded votes (a pre-v2 output) cannot show a FALSE vote, so it is NOT_CHECKED', () => {
      expect(isNotCheckedV2({ verdict: 'vetoed', mode: 'fact-check' })).toBe(true);
    });

    it('a clean is unaffected by the new rule; v1 cases stay NOT_CHECKED', () => {
      expect(isNotCheckedV2({ verdict: 'clean', mode: 'fact-check', votes: { TRUE: 2 } })).toBe(false);
      expect(isNotCheckedV2({ verdict: 'abstain', mode: 'fact-check' })).toBe(true);
      expect(isNotCheckedV2({ error: 'HTTP 429' })).toBe(true);
    });
  });

  describe('scoring v3: a row decided on fewer than two families is NOT_CHECKED', () => {
    // Lane A baseline 2026-10-16: 9 of 40 rows were one-family holds ('flagged'), 7 on hallucinations.
    // v2 read the hold as a negative answer, so each of those 7 scored as a miss.
    it('a one-family hold is not an answer: v2 counted it, v3 does not', () => {
      const hold = { verdict: 'flagged', mode: 'fact-check', familiesUsed: 1, votes: { FALSE: 1, ERROR: 4 } };
      expect(isNotCheckedV2(hold)).toBe(false);
      expect(isNotCheckedV3(hold)).toBe(true);
      expect(confusionMatrix([{ truth: 'FALSE', ...hold }].filter((r) => !isNotCheckedV3(r)))).toEqual({ tp: 0, fp: 0, tn: 0, fn: 0 });
    });

    it('two families decide; an unknown family count is conservative', () => {
      expect(isNotCheckedV3({ verdict: 'vetoed', mode: 'fact-check', familiesUsed: 2, votes: { FALSE: 2 } })).toBe(false);
      expect(isNotCheckedV3({ verdict: 'clean', mode: 'fact-check', familiesUsed: 3, votes: { TRUE: 3 } })).toBe(false);
      expect(isUnderQuorum({})).toBe(true);
      expect(isNotCheckedV3({ verdict: 'clean', mode: 'fact-check', votes: { TRUE: 2 } })).toBe(true);
    });

    it('everything v2 calls NOT_CHECKED stays NOT_CHECKED', () => {
      expect(isNotCheckedV3({ verdict: 'vetoed', mode: 'fact-check', familiesUsed: 2, votes: { UNCERTAIN: 2 } })).toBe(true);
      expect(isNotCheckedV3({ error: 'HTTP 429' })).toBe(true);
    });
  });
});
