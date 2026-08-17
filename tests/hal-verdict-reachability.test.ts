/**
 * hal-verdict-reachability.test.ts
 *
 * The guard's whole value is that it does NOT fire on rows this codebase can legitimately produce.
 * A predicate built naively from `deriveHalDecision` alone flags 3,063 live rows that are fine
 * (`flagged` below 0.40, forced by `pipeline.ts` when HAL throws) — and a guard that cries wolf
 * gets switched off. So the false-positive tests below are the load-bearing ones, not the
 * true-positive ones.
 *
 * Fixtures are the shapes MEASURED in prod [V SQL 2026-08-17], not invented examples.
 */

import {
  KNOWN_DECISIONS,
  MEASURED_LIVE_SHAPES,
  isReachableVerdict,
  partitionByReachability,
  verdictReachability,
} from '../src/scoring/hal-verdict-reachability';
import { deriveHalDecision } from '../src/scoring/pipeline';

describe('the two shapes prod carries that no producer can emit', () => {
  it("flags clean at or above the flag boundary — 556 live rows", () => {
    const r = verdictReachability({ hal_score: 0.5, hal_decision: 'clean' });
    expect(r.reachable).toBe(false);
    expect(r.reason).toBe('NO_WITNESS_PRODUCES_THIS_DECISION');
    expect(r.via).toEqual([]);
  });

  it('flags a decision outside the HALDecision union — 12 live APPROVE rows', () => {
    const r = verdictReachability({ hal_score: null, hal_decision: 'APPROVE' });
    expect(r.reachable).toBe(false);
    expect(r.reason).toBe('FOREIGN_DECISION_VOCABULARY');
    // The vocabulary check must run BEFORE the missing-score check: 'APPROVE' rows also have no
    // score, and reporting the score as the problem would send someone to fix the wrong thing.
    expect(r.detail).toContain('not a HALDecision');
  });

  it('flags a known decision recorded without its score — 70 live clean rows', () => {
    const r = verdictReachability({ hal_score: null, hal_decision: 'clean' });
    expect(r.reachable).toBe(false);
    expect(r.reason).toBe('DECISION_WITHOUT_SCORE');
  });
});

describe('the false positives that would have got this guard switched off', () => {
  it('does NOT flag flagged-below-the-boundary — 3,063 live rows, all legitimate', () => {
    // pipeline.ts: `const decision = halError ? 'flagged' : deriveHalDecision(...)`. A HAL
    // exception forces flagged at whatever score is on the row. Flagging on detector failure is
    // the fail-closed direction, so these rows are correct and must not be reported as defects.
    for (const score of [0, 0.05, 0.2, 0.3, 0.39]) {
      const r = verdictReachability({ hal_score: score, hal_decision: 'flagged' });
      expect({ score, reachable: r.reachable }).toEqual({ score, reachable: true });
      expect(r.via.join(' ')).toContain('halError override');
    }
    // …and the gate itself reaches flagged above the boundary, without needing the override.
    expect(verdictReachability({ hal_score: 0.9, hal_decision: 'flagged' }).via.join(' ')).toContain(
      'deriveHalDecision',
    );
  });

  it('does NOT flag vetoed at any score — 115,887 live rows', () => {
    for (const score of [0, 0.2169, 0.5, 1]) {
      expect(isReachableVerdict({ hal_score: score, hal_decision: 'vetoed' })).toBe(true);
    }
  });

  it('does NOT flag a row that simply never ran HAL', () => {
    // Most event types have no decision at all. Treating absence as a defect would flag the
    // majority of the ledger and say nothing.
    expect(isReachableVerdict({ hal_score: null, hal_decision: null })).toBe(true);
    expect(isReachableVerdict({ hal_score: null, hal_decision: '   ' })).toBe(true);
  });

  it('every measured live shape lands on its measured verdict', () => {
    for (const shape of MEASURED_LIVE_SHAPES) {
      const got = isReachableVerdict(shape);
      expect({ note: shape.note, reachable: got }).toEqual({
        note: shape.note,
        reachable: shape.expectReachable,
      });
    }
  });
});

describe('the threshold is DERIVED, never restated', () => {
  it('agrees with deriveHalDecision across the range, by construction', () => {
    // If someone restates 0.40 in the reachability module, this drifts the moment the gate moves.
    // Sweeping both against each other is what keeps the two ends wired together — the same
    // failure `formula-golden-vector.ts` closes one layer down.
    for (let i = 0; i <= 100; i++) {
      const score = i / 100;
      const gate = deriveHalDecision(score, false);
      expect({ score, reachable: isReachableVerdict({ hal_score: score, hal_decision: gate }) }).toEqual({
        score,
        reachable: true,
      });
    }
  });

  it('finds the boundary where the gate actually puts it, not where a constant says', () => {
    // Derive the clean/flagged crossover from the guard's own answers and check it matches the
    // gate's. No literal 0.40 appears in this assertion.
    let lastCleanReachable = -1;
    for (let i = 0; i <= 1000; i++) {
      const score = i / 1000;
      if (isReachableVerdict({ hal_score: score, hal_decision: 'clean' })) lastCleanReachable = score;
    }
    expect(deriveHalDecision(lastCleanReachable, false)).toBe('clean');
    expect(deriveHalDecision(lastCleanReachable + 0.001, false)).toBe('flagged');
  });

  it('abstain is not reachable through the gate — and prod has zero abstain rows', () => {
    // `HALDecision` admits 'abstain' and `computeDelta` handles it, but `deriveHalDecision` never
    // returns it. Recorded so that if abstain rows ever appear, this test names why they are odd
    // rather than someone assuming the guard is broken.
    expect(KNOWN_DECISIONS).toContain('abstain');
    for (let i = 0; i <= 100; i++) {
      expect(deriveHalDecision(i / 100, false)).not.toBe('abstain');
    }
    expect(isReachableVerdict({ hal_score: 0.2, hal_decision: 'abstain' })).toBe(false);
  });
});

describe('partitioning reports what it dropped', () => {
  it('counts and reasons, so a filtered metric can state its own subset', () => {
    const rows = [
      { hal_score: 0.25, hal_decision: 'clean' },     // ok
      { hal_score: 0.9, hal_decision: 'vetoed' },     // ok
      { hal_score: 0.2, hal_decision: 'flagged' },    // ok (halError)
      { hal_score: 0.5, hal_decision: 'clean' },      // unreachable
      { hal_score: 0.7, hal_decision: 'clean' },      // unreachable
      { hal_score: null, hal_decision: 'APPROVE' },   // unreachable
    ];
    const p = partitionByReachability(rows);
    expect(p.total).toBe(6);
    expect(p.reachable).toHaveLength(3);
    expect(p.droppedCount).toBe(3);
    expect(p.reasons).toEqual({
      NO_WITNESS_PRODUCES_THIS_DECISION: 2,
      FOREIGN_DECISION_VOCABULARY: 1,
    });
  });

  it('drops nothing when every row is legitimate', () => {
    const p = partitionByReachability([
      { hal_score: 0.1, hal_decision: 'clean' },
      { hal_score: 0.99, hal_decision: 'vetoed' },
    ]);
    expect(p.droppedCount).toBe(0);
    expect(p.reasons).toEqual({});
  });
});
