/**
 * Help B — schema only.
 *
 * A rating is not a score. Nothing here writes, and nothing here moves an
 * agent's RepID. A missing `n` is NOT_CHECKED. It is not zero.
 */

export type RaterType = 'human' | 'agent';
export type HelpSubject = 'family' | 'agent';
export type HelpDim = 'helpful' | 'deep' | 'accurate';

export interface HelpBInput {
  rater_type?: RaterType;
  subject?: HelpSubject;
  dim?: HelpDim;
  /** 0 to 1 when the rating was actually collected. */
  value?: number;
  /** How many ratings are in `value`. Missing means nobody counted. */
  n?: number;
}

export interface HelpBRecord {
  rater_type: RaterType | null;
  subject: HelpSubject | null;
  dim: HelpDim | null;
  value: number | null;
  n: number | null;
  status: 'recorded' | 'NOT_CHECKED';
}

const RATERS = new Set<RaterType>(['human', 'agent']);
const SUBJECTS = new Set<HelpSubject>(['family', 'agent']);
const DIMS = new Set<HelpDim>(['helpful', 'deep', 'accurate']);

function inRange(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Read one Help B row. Does not query and does not insert.
 * Missing `n`, a non-finite `n`, or `n` below 1 is NOT_CHECKED and leaves
 * `value` null so an empty rating cannot be scored as 0.
 */
export function readHelpB(input: HelpBInput | null | undefined): HelpBRecord {
  const blank: HelpBRecord = {
    rater_type: null,
    subject: null,
    dim: null,
    value: null,
    n: null,
    status: 'NOT_CHECKED',
  };
  if (input == null || input.n === undefined || input.n === null || !Number.isFinite(input.n) || input.n < 1) {
    return blank;
  }
  const rater = RATERS.has(input.rater_type as RaterType) ? (input.rater_type as RaterType) : null;
  const subject = SUBJECTS.has(input.subject as HelpSubject) ? (input.subject as HelpSubject) : null;
  const dim = DIMS.has(input.dim as HelpDim) ? (input.dim as HelpDim) : null;
  const value = typeof input.value === 'number' && inRange(input.value) ? input.value : null;
  if (rater === null || subject === null || dim === null || value === null) return blank;
  return {
    rater_type: rater,
    subject,
    dim,
    value,
    n: input.n,
    status: 'recorded',
  };
}
