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
