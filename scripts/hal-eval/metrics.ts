/**
 * metrics.ts — the pure scoring math behind run-frozen-corpus-local.ts.
 *
 * Extracted so it can be unit-tested WITHOUT any provider call: the harness's
 * confusion matrix, precision/recall/F1 and ROC AUC are deterministic functions
 * of (truth label, verdict, halScore). The measured F1/AUC on the real corpus is
 * DATA — it depends on live LLMs and must never be asserted in a test. The
 * MACHINERY that turns verdicts into those numbers is code, and that is what the
 * smoke test pins here.
 *
 * Positive class = HALLUCINATION. A corpus row labelled FALSE is a hallucination
 * (the claim is false); the HAL veto is the model predicting "hallucination".
 */

import { createHash } from 'crypto';

/** Ground-truth FALSE ⇒ the claim is false ⇒ positive (hallucination). */
export const isHallucination = (label: string): boolean => String(label).toUpperCase() === 'FALSE';

/** A 'vetoed' HAL decision is a positive prediction; 'clean'/'flagged'/'abstain' are not. */
export const predictedHallucination = (verdict?: string): boolean => /veto/i.test(String(verdict));

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export interface ScoredRow {
  truth: string;
  verdict?: string;
}

/** Confusion matrix over scored rows (positive = hallucination). */
export function confusionMatrix(rows: ScoredRow[]): Confusion {
  const c: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const r of rows) {
    const truth = isHallucination(r.truth);
    const pred = predictedHallucination(r.verdict);
    if (truth && pred) c.tp++;
    else if (!truth && pred) c.fp++;
    else if (!truth && !pred) c.tn++;
    else c.fn++;
  }
  return c;
}

export interface Prf1 {
  precision: number;
  recall: number;
  f1: number;
  accuracy: number;
}

export function prf1({ tp, fp, tn, fn }: Confusion): Prf1 {
  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  const n = tp + fp + tn + fn;
  const accuracy = n ? (tp + tn) / n : 0;
  return { precision, recall, f1, accuracy };
}

/**
 * ROC AUC (positive class = hallucination), ranking by a continuous score
 * (halScore). Tie-aware Mann–Whitney U with mid-ranks, so a degenerate
 * all-equal-score run yields exactly 0.5 rather than an inflated value. Returns
 * null when only one class is present (AUC is undefined then).
 *
 * Reported as a DIAGNOSTIC only: it ranks the continuous score, whereas F1 is
 * taken at the deployed veto threshold — the two answer different questions.
 */
export function rocAuc(points: Array<{ score: number; positive: boolean }>): number | null {
  const pos = points.filter((p) => p.positive).length;
  const neg = points.length - pos;
  if (pos === 0 || neg === 0) return null;
  const sorted = [...points].sort((a, b) => a.score - b.score);
  const ranks = new Array<number>(sorted.length);
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1]!.score === sorted[i]!.score) j++;
    const midRank = (i + j) / 2 + 1; // average 1-based rank of the tie group
    for (let k = i; k <= j; k++) ranks[k] = midRank;
    i = j + 1;
  }
  let sumRanksPos = 0;
  for (let k = 0; k < sorted.length; k++) if (sorted[k]!.positive) sumRanksPos += ranks[k]!;
  return (sumRanksPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

/**
 * NOT_CHECKED — HAL did not judge the row: the call failed, the quorum fell back to the style
 * extractor, or the decision is 'abstain' (fewer than two families, or the prefilter skipped it).
 * confusionMatrix() scores an abstain as a negative prediction, so on a TRUE row "not judged"
 * reads as "correctly passed". The runner therefore reports the NOT_CHECKED rate beside F1 and
 * also gives an F1 over checked rows only.
 */
export function isNotChecked(r: { error?: string; verdict?: string; mode?: string }): boolean {
  return Boolean(r.error) || !r.verdict || /abstain/i.test(r.verdict) || (r.mode !== undefined && r.mode !== 'fact-check');
}

export interface ClassScore {
  precision: number;
  recall: number;
  f1: number;
  support: number;
}

/** Precision/recall/F1 for BOTH classes: hallucination (label FALSE) and supported (label TRUE). */
export function perClass({ tp, fp, tn, fn }: Confusion): { hallucination: ClassScore; supported: ClassScore } {
  const cls = (hit: number, falseAlarm: number, miss: number): ClassScore => {
    const precision = hit + falseAlarm > 0 ? hit / (hit + falseAlarm) : 0;
    const recall = hit + miss > 0 ? hit / (hit + miss) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return { precision, recall, f1, support: hit + miss };
  };
  return { hallucination: cls(tp, fp, fn), supported: cls(tn, fn, fp) };
}

/**
 * The order a --limit / --max-calls prefix is taken in: each class sorted by sha256(id), then
 * alternated. Defined by content alone (file order cannot move it), mixes sources, and keeps
 * every prefix within one row of class balance, so a small budgeted run still reports both classes.
 */
export function evalOrder<T extends { id: string; label: string }>(rows: T[]): T[] {
  const key = new Map(rows.map((r) => [r, createHash('sha256').update(r.id).digest('hex')]));
  const byKey = (a: T, b: T) => (key.get(a)! < key.get(b)! ? -1 : 1);
  const pos = rows.filter((r) => isHallucination(r.label)).sort(byKey);
  const neg = rows.filter((r) => !isHallucination(r.label)).sort(byKey);
  const out: T[] = [];
  for (let i = 0; i < Math.max(pos.length, neg.length); i++) {
    if (pos[i]) out.push(pos[i]!);
    if (neg[i]) out.push(neg[i]!);
  }
  return out;
}

/**
 * The scoring rule a run's `checked` numbers are taken under. Numbers under different scorings are
 * different rulers and are never compared (CLAUDE_RULES 24).
 *   v1 (2026-10-14): NOT_CHECKED = an error, an abstain or an extractor fallback (isNotChecked).
 *   v2: v1, plus a veto no checker voted FALSE for. A veto built only of UNCERTAIN votes (halScore
 *       0.5, the all-UNCERTAIN over-veto) is not a catch. A row with no recorded votes, such as an
 *       output written before v2, cannot show a FALSE vote and so reads NOT_CHECKED. A veto forced
 *       by the ground-truth gate or the execution floor with no FALSE vote reads NOT_CHECKED too:
 *       conservative on purpose.
 *   v3 (2026-10-16): v2, plus a row HAL decided on fewer than two model families. HAL itself says
 *       such a row is not judged: with one family a would-be veto is HELD at 'flagged' and a would-be
 *       clean becomes 'abstain' (fact-check.ts, MIN_QUORUM_FOR_VETO). v2 caught the abstain but read
 *       the held 'flagged' as a negative answer, so every under-quorum row on a hallucination scored
 *       as a miss: on the Lane A baseline (2026-10-16) 9 of 40 rows were 1-family holds, 7 of them FN.
 *       A row with no recorded family count reads NOT_CHECKED (conservative, like v2's no-votes rule).
 */
export const SCORING = 'v3-two-families-or-not-checked';

/** A veto that no checker voted FALSE for. */
export function isNoAgreementVeto(r: { verdict?: string; votes?: Record<string, number> }): boolean {
  return predictedHallucination(r.verdict) && !((r.votes?.FALSE ?? 0) > 0);
}

/** NOT_CHECKED under scoring v2. */
export function isNotCheckedV2(r: { error?: string; verdict?: string; mode?: string; votes?: Record<string, number> }): boolean {
  return isNotChecked(r) || isNoAgreementVeto(r);
}

/** Decided on fewer than two model families, or on an unknown number of them. */
export function isUnderQuorum(r: { familiesUsed?: number }): boolean {
  return !(typeof r.familiesUsed === 'number' && r.familiesUsed >= 2);
}

/** NOT_CHECKED under scoring v3 (SCORING). */
export function isNotCheckedV3(r: { error?: string; verdict?: string; mode?: string; votes?: Record<string, number>; familiesUsed?: number }): boolean {
  return isNotCheckedV2(r) || isUnderQuorum(r);
}
