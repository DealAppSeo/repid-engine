/**
 * CHECKER LEDGER SCORING (Sean, 2026-10-06). Pure functions: counts in, a reading out.
 *
 * THE COST OF A WRONG ANSWER IS A DECISION, NOT A FACT. K_WRONG = 3 means one wrong verdict costs
 * what three right ones earn, and "unsure" or no answer earns 0. On the 2026-10-05 run the two
 * production checkers TIE at exactly k = 3 (256 - 3x40 = 178 - 3x14 = 136): below 3 the one that
 * guesses more wins, above 3 the careful one does. So k is pinned here and changed only by the
 * operator, never tuned to make a model look better.
 *
 * THE SCORE NEVER REWARDS ABSTAINING. Unsure earns 0, the same as no answer. A checker that says
 * UNSURE to everything scores 0, not "never wrong". That is the Goodhart defense for the checker
 * side: there is no way to raise the score except being right more often than wrong times k.
 *
 * NOTHING UNDER DISPLAY_FLOOR IS A RATE. Under 100 answers in a slice the 95% range on a rate near
 * 80% is wider than +/- 8 points, so a slice that small reports its counts and `shown: false`.
 * A percentage there would read as measured and would not be.
 */

export const K_WRONG = 3;
export const DISPLAY_FLOOR = 100;

export interface SliceCounts {
  right: number;
  wrong: number;
  unsure: number;
  /** Sent and no verdict came back, or not sent at all. */
  none: number;
}

export interface Range {
  lo: number;
  hi: number;
}

export interface SliceReading {
  n: number;
  answered: number;
  /** right - k x wrong, over the whole slice. */
  score: number;
  /** score / n: comparable across slices of different size. */
  perClaim: number | null;
  /** Right over answered (TRUE or FALSE given). null when nothing was answered. */
  precision: number | null;
  precisionRange: Range | null;
  /** answered / n */
  coverage: number | null;
  /** False under DISPLAY_FLOOR: print the counts, never a rate. */
  shown: boolean;
}

/** Wilson score interval for k successes in n trials (95% by default). null when n is 0. */
export function wilson(k: number, n: number, z = 1.96): Range | null {
  if (!(n > 0) || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: (centre - half) / denom, hi: (centre + half) / denom };
}

export function readSlice(c: SliceCounts, k: number = K_WRONG): SliceReading {
  const n = c.right + c.wrong + c.unsure + c.none;
  const answered = c.right + c.wrong;
  const score = c.right - k * c.wrong;
  return {
    n,
    answered,
    score,
    perClaim: n > 0 ? score / n : null,
    precision: answered > 0 ? c.right / answered : null,
    precisionRange: wilson(c.right, answered),
    coverage: n > 0 ? answered / n : null,
    shown: n >= DISPLAY_FLOOR,
  };
}

export type Answer = 'TRUE' | 'FALSE' | 'UNSURE' | 'NONE';

/** One item's worth under k: +1 right, -k wrong, 0 for unsure or no answer. */
export function utility(answer: Answer, truth: 'TRUE' | 'FALSE', k: number = K_WRONG): number {
  if (answer === 'UNSURE' || answer === 'NONE') return 0;
  return answer === truth ? 1 : -k;
}

/** Two-sided exact sign test: how likely a split at least this lopsided is by chance. */
export function signTest(aBetter: number, bBetter: number): number {
  const n = aBetter + bBetter;
  if (n === 0) return 1;
  const hi = Math.max(aBetter, bBetter);
  // P(X >= hi) for X ~ Binomial(n, 1/2), via log-space terms so n in the thousands stays finite.
  let logC = 0; // log C(n, 0)
  const logHalfN = n * Math.log(0.5);
  let tail = 0;
  for (let i = 0; i <= n; i += 1) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    if (i >= hi) tail += Math.exp(logC + logHalfN);
  }
  return Math.min(1, 2 * tail);
}

export interface PairedItem {
  truth: 'TRUE' | 'FALSE';
  a: Answer;
  b: Answer;
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, error under 1.5e-7). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/**
 * A against B on the SAME items, under k. Only the paired difference in worth decides it.
 *
 * WHY NOT A SIGN TEST HERE. A sign test counts which side won each item and ignores by how much. Under
 * k = 3 a wrong answer costs three right ones, so the sizes differ: on 2026-10-05 gpt-oss won 90
 * items and qwen 38 (a sign test says p < 0.001, "gpt-oss is better"), yet their totals tie at 136
 * because each of qwen's wins was a wrong answer it avoided, worth 3. The z-test on the mean paired
 * difference keeps the magnitude. `aBetter` / `bBetter` are reported for reading, not for deciding.
 */
export function comparePaired(items: readonly PairedItem[], k: number = K_WRONG) {
  let aBetter = 0;
  let bBetter = 0;
  const diffs: number[] = [];
  for (const it of items) {
    const d = utility(it.a, it.truth, k) - utility(it.b, it.truth, k);
    if (d > 0) aBetter += 1;
    else if (d < 0) bBetter += 1;
    diffs.push(d);
  }
  const n = diffs.length;
  const total = diffs.reduce((x, y) => x + y, 0);
  const mean = n > 0 ? total / n : 0;
  const variance = n > 1 ? diffs.reduce((acc, d) => acc + (d - mean) ** 2, 0) / (n - 1) : 0;
  const se = n > 1 ? Math.sqrt(variance / n) : 0;
  const z = se > 0 ? mean / se : 0;
  const p = se > 0 ? 2 * (1 - normalCdf(Math.abs(z))) : 1;
  return { items: n, aBetter, bBetter, difference: total, z, p };
}

/** One TRUE and one FALSE: both stated flatly, and they cannot both be right. */
export function contradicted(a: Answer, b: Answer): boolean {
  return (a === 'TRUE' && b === 'FALSE') || (a === 'FALSE' && b === 'TRUE');
}
