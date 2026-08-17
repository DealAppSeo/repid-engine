/**
 * hal-verdict-reachability.ts — could this stored HAL verdict have come from this codebase?
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE FINDING THIS CLOSES [V SQL 2026-08-17]
 * ════════════════════════════════════════════════════════════════════════════════
 * `repid_score_events.hal_decision` is written by several producers, and 568 rows carry a
 * (`hal_score`, `hal_decision`) pair that **no code path in this repo can emit**:
 *
 *   • 556 rows  `hal_decision='clean'` with `hal_score >= 0.40`.
 *     `deriveHalDecision` returns `clean` only BELOW 0.40, and nothing overrides a decision
 *     to `clean`. So the pair is unreachable — it is not a measurement.
 *   • 12 rows   `hal_decision='APPROVE'`.
 *     Not a member of the `HALDecision` union at all. A writer using a foreign vocabulary.
 *
 * Both matter because `hal_decision` is read by the PUBLIC, unauthenticated `GET /agents/:id`
 * (`routes/agents-external.ts`), which counts `hal_decision='clean'` into `total_clean` with no
 * producer filter. An unreachable verdict therefore reaches an external number.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS MODULE IS *NOT*, AND THE 3,063 ROWS THAT TAUGHT ME THE DIFFERENCE
 * ════════════════════════════════════════════════════════════════════════════════
 * The naive predicate is "recompute `deriveHalDecision` and compare". Run that against prod and
 * it flags **3,063 rows** as bad: `hal_decision='flagged'` with `hal_score < 0.40`, which
 * `deriveHalDecision` indeed never returns.
 *
 * All 3,063 are FINE. `scoring/pipeline.ts` reads
 *
 *     const decision = halError ? 'flagged' : deriveHalDecision(...)
 *
 * so a HAL *exception* forces `flagged` at whatever score is on the row. That is a deliberate
 * degraded path, not a defect — flagging when the detector failed is the fail-closed direction.
 *
 * So reachability is a question about the WHOLE producer set, not about one function. A predicate
 * built from `deriveHalDecision` alone would have cried wolf 3,063 times and been switched off,
 * which is how a guard becomes worse than no guard. Every override below is enumerated
 * explicitly and cites the code that performs it.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY ENUMERATION, NOT RESTATEMENT
 * ════════════════════════════════════════════════════════════════════════════════
 * Two of `deriveHalDecision`'s three inputs — `vetoed` and `comma_severity` — are NOT columns on
 * `repid_score_events`. Only the score and the decision are stored. So the honest question is
 * existential: **does there exist** a witness `(vetoed, comma_severity)` under which some producer
 * emits this decision at this score?
 *
 * That is decidable, because both unobserved inputs are effectively boolean (`vetoed`, and
 * `comma_severity === 'critical'`). This module enumerates all four combinations by CALLING the
 * real `deriveHalDecision`, and never restates the 0.40 boundary. Change that threshold and this
 * module follows it for free; restate it here and the two drift apart, which is precisely the
 * failure `formula-golden-vector.ts` exists to prevent one layer down.
 *
 * PURITY: no I/O, no env, no clock.
 */

import { deriveHalDecision } from './pipeline';
import type { HALDecision } from './repid-delta';

/** The decisions `HALDecision` actually admits. Anything else is a foreign vocabulary. */
export const KNOWN_DECISIONS: readonly HALDecision[] = ['clean', 'flagged', 'vetoed', 'abstain'];

/**
 * The unobserved half of `deriveHalDecision`'s input, enumerated.
 *
 * `comma_severity` is passed as `'critical'` or `null` only: `deriveHalDecision` compares it for
 * equality with `'critical'`, so every other string is behaviourally identical to `null`.
 */
const WITNESSES: ReadonlyArray<{ vetoed: boolean; comma: string | null; label: string }> = [
  { vetoed: false, comma: null, label: 'normal path' },
  { vetoed: true, comma: null, label: 'detector vetoed' },
  { vetoed: false, comma: 'critical', label: 'critical Comma BFT severity' },
  { vetoed: true, comma: 'critical', label: 'vetoed + critical Comma' },
];

export type UnreachableReason =
  | 'FOREIGN_DECISION_VOCABULARY'
  | 'NO_WITNESS_PRODUCES_THIS_DECISION'
  | 'DECISION_WITHOUT_SCORE';

export interface Reachability {
  readonly reachable: boolean;
  /** Producers that could have emitted this pair. Empty iff `reachable` is false. */
  readonly via: readonly string[];
  readonly reason: UnreachableReason | null;
  /** One line a reader can act on. Never blames a row the codebase can in fact produce. */
  readonly detail: string;
}

const OK = (via: readonly string[]): Reachability =>
  Object.freeze({ reachable: true, via: Object.freeze([...via]), reason: null, detail: 'reachable' });

const BAD = (reason: UnreachableReason, detail: string): Reachability =>
  Object.freeze({ reachable: false, via: Object.freeze([]), reason, detail });

/**
 * Could some producer in this repo have written this (score, decision) pair?
 *
 * A `null`/absent score is treated as UNREACHABLE when a decision is present: every producer
 * derives the decision FROM a score, so a decision with no score is a row that recorded the
 * verdict and discarded the evidence. 70 such `clean` rows exist [V SQL 2026-08-17]. This is the
 * one judgement call in the module, and it is called out rather than buried: if a producer is
 * later found that legitimately decides without a score, this is the line to revisit.
 */
export function verdictReachability(row: {
  hal_score: number | null | undefined;
  hal_decision: string | null | undefined;
}): Reachability {
  const decision = typeof row.hal_decision === 'string' ? row.hal_decision.trim() : '';
  if (decision.length === 0) {
    // No decision at all is not a defect — plenty of event types never run HAL.
    return OK(['no decision recorded']);
  }

  if (!(KNOWN_DECISIONS as readonly string[]).includes(decision)) {
    return BAD(
      'FOREIGN_DECISION_VOCABULARY',
      `'${decision}' is not a HALDecision — no producer in this repo emits it, so the row was ` +
        `written by something using a different vocabulary`,
    );
  }

  const score = row.hal_score;
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return BAD(
      'DECISION_WITHOUT_SCORE',
      `decision '${decision}' recorded with no hal_score — every producer derives the decision ` +
        `from a score, so the verdict is here and its evidence is not`,
    );
  }

  const via: string[] = [];

  // Producer 1 — the gate itself, over every witness the row does not store.
  for (const w of WITNESSES) {
    if (deriveHalDecision(score, w.vetoed, w.comma) === decision) {
      via.push(`deriveHalDecision (${w.label})`);
    }
  }

  // Producer 2 — the documented degraded override in scoring/pipeline.ts:
  //   `const decision = halError ? 'flagged' : deriveHalDecision(...)`
  // This is what makes the 3,063 flagged-below-0.40 rows legitimate. Enumerated, not assumed.
  if (decision === 'flagged') {
    via.push('scoring/pipeline.ts halError override (HAL threw — degraded, fail-closed)');
  }

  if (via.length === 0) {
    return BAD(
      'NO_WITNESS_PRODUCES_THIS_DECISION',
      `no producer emits '${decision}' at hal_score ${score}: the gate returns something else ` +
        `under every (vetoed, comma_severity) combination, and no override forces '${decision}'`,
    );
  }
  return OK(via);
}

/** Convenience predicate for filtering a batch. */
export function isReachableVerdict(row: {
  hal_score: number | null | undefined;
  hal_decision: string | null | undefined;
}): boolean {
  return verdictReachability(row).reachable;
}

/**
 * Partition rows, so a caller can report a metric over the reachable set and SAY SO rather than
 * silently averaging fabrications into it.
 *
 * Returns counts alongside the rows: a consumer that drops rows must be able to publish how many
 * it dropped. A number computed over a filtered subset without stating the subset is the same
 * class of defect this module exists to surface.
 */
export function partitionByReachability<
  T extends { hal_score: number | null | undefined; hal_decision: string | null | undefined },
>(rows: readonly T[]): {
  reachable: T[];
  unreachable: Array<{ row: T; reachability: Reachability }>;
  total: number;
  droppedCount: number;
  reasons: Record<string, number>;
} {
  const reachable: T[] = [];
  const unreachable: Array<{ row: T; reachability: Reachability }> = [];
  const reasons: Record<string, number> = {};
  for (const row of rows) {
    const r = verdictReachability(row);
    if (r.reachable) {
      reachable.push(row);
    } else {
      unreachable.push({ row, reachability: r });
      const key = r.reason ?? 'UNKNOWN';
      reasons[key] = (reasons[key] ?? 0) + 1;
    }
  }
  return {
    reachable,
    unreachable,
    total: rows.length,
    droppedCount: unreachable.length,
    reasons,
  };
}

/**
 * The live shapes this module was built from, pinned so the test asserts against measured reality
 * rather than against invented examples. Counts are [V SQL 2026-08-17] against `repid_score_events`
 * (152,161 rows).
 */
export const MEASURED_LIVE_SHAPES: ReadonlyArray<{
  readonly hal_score: number | null;
  readonly hal_decision: string;
  readonly rows: number;
  readonly expectReachable: boolean;
  readonly note: string;
}> = [
  {
    hal_score: 0.5,
    hal_decision: 'clean',
    rows: 556,
    expectReachable: false,
    note: 'clean at/above the flag boundary — no producer emits it; feeds total_clean on a public endpoint',
  },
  {
    hal_score: null,
    hal_decision: 'APPROVE',
    rows: 12,
    expectReachable: false,
    note: 'foreign vocabulary — not a HALDecision',
  },
  {
    hal_score: 0.2,
    hal_decision: 'flagged',
    rows: 3063,
    expectReachable: true,
    note: 'flagged below the boundary IS legitimate — pipeline.ts forces flagged when HAL throws',
  },
  {
    hal_score: 0.9,
    hal_decision: 'vetoed',
    rows: 115887,
    expectReachable: true,
    note: 'vetoed is reachable at any score via vetoed=true or critical Comma',
  },
  {
    hal_score: 0.25,
    hal_decision: 'clean',
    rows: 10648,
    expectReachable: true,
    note: 'the ordinary clean path, below the boundary',
  },
];
