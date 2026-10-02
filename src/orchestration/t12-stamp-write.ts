/**
 * Stamp record a reader can load. No claim text and no user id.
 * A veto writes caught. A pass writes pass.
 * A timeout, a miss, and a missing score write NOT_CHECKED, never 0.
 */

export type T12StampWord = 'caught' | 'pass' | 'NOT_CHECKED';

export interface T12StampRecord {
  stamp: T12StampWord;
  score: number | 'NOT_CHECKED';
}

export interface T12StampInput {
  verdict?: unknown;
  score?: unknown;
  timeout?: boolean;
}

function word(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function veto(value: unknown): boolean {
  const text = word(value);
  return text === 'veto' || text === 'vetoed' || text === 'false';
}

function pass(value: unknown): boolean {
  const text = word(value);
  return text === 'pass' || text === 'true';
}

/** A missing score, 0, and "0" are NOT_CHECKED. */
export function writeT12Score(score: unknown): number | 'NOT_CHECKED' {
  if (typeof score === 'number' && Number.isFinite(score) && score !== 0) return score;
  return 'NOT_CHECKED';
}

export function writeT12Stamp(input: T12StampInput = {}): T12StampRecord {
  const score = writeT12Score(input.score);
  if (input.timeout === true || word(input.verdict) === 'timeout') {
    return { stamp: 'NOT_CHECKED', score };
  }
  if (veto(input.verdict)) return { stamp: 'caught', score };
  if (pass(input.verdict)) return { stamp: 'pass', score };
  return { stamp: 'NOT_CHECKED', score };
}

/** What the stamp reads. A missing record is NOT_CHECKED, not 0. */
export function readT12Stamp(record: T12StampRecord | null | undefined): T12StampWord {
  if (!record) return 'NOT_CHECKED';
  if (record.stamp === 'caught' || record.stamp === 'pass' || record.stamp === 'NOT_CHECKED') {
    return record.stamp;
  }
  return 'NOT_CHECKED';
}

export interface T12TrapClaim {
  trap?: unknown;
  first_pass_verdict?: unknown;
  post_hal_verdict?: unknown;
}

export function writeT12TrapLine(claim: T12TrapClaim): {
  trap: string;
  firstPass: T12StampWord;
  postCheck: T12StampWord;
} {
  const trap = typeof claim.trap === 'string' && claim.trap.length > 0 ? claim.trap : 'row';
  return {
    trap,
    firstPass: writeT12Stamp({ verdict: claim.first_pass_verdict }).stamp,
    postCheck: writeT12Stamp({ verdict: claim.post_hal_verdict }).stamp,
  };
}

/** Ten fixture rows. Columns are first-pass and post-check. A miss is NOT_CHECKED. */
export function printT12TrapTable(claims: readonly T12TrapClaim[]): string {
  const lines = ['trap\tfirst-pass\tpost-check'];
  for (const claim of claims) {
    const row = writeT12TrapLine(claim);
    lines.push(`${row.trap}\t${row.firstPass}\t${row.postCheck}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * A self-only row does not raise the score.
 * A missing start is NOT_CHECKED, not 0.
 */
export function scoreAfterStampRow(
  start: number,
  row: { rater_id?: string | null; subject_id?: string | null; delta?: unknown },
): number | 'NOT_CHECKED' {
  if (typeof start !== 'number' || !Number.isFinite(start)) return 'NOT_CHECKED';
  const self =
    typeof row.rater_id === 'string' &&
    row.rater_id.length > 0 &&
    row.rater_id === row.subject_id;
  if (self) return start;
  const delta = row.delta;
  if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0 || delta < 0) return start;
  return start + delta;
}
