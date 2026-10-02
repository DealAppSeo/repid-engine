/**
 * Stamp record a reader can load. No claim text and no user id.
 * A veto writes caught. A pass writes pass.
 * A timeout and a missing score write NOT_CHECKED, never 0.
 */

export type StampWord = 'caught' | 'pass' | 'NOT_CHECKED';

export interface StampRecord {
  stamp: StampWord;
  score: number | 'NOT_CHECKED';
}

export interface StampInput {
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
export function writeStampScore(score: unknown): number | 'NOT_CHECKED' {
  if (typeof score === 'number' && Number.isFinite(score) && score !== 0) return score;
  return 'NOT_CHECKED';
}

export function writeStamp(input: StampInput = {}): StampRecord {
  const score = writeStampScore(input.score);
  if (input.timeout === true || word(input.verdict) === 'timeout') {
    return { stamp: 'NOT_CHECKED', score };
  }
  if (veto(input.verdict)) return { stamp: 'caught', score };
  if (pass(input.verdict)) return { stamp: 'pass', score };
  return { stamp: 'NOT_CHECKED', score };
}

export interface TrapClaim {
  trap?: unknown;
  first_pass_verdict?: unknown;
  post_hal_verdict?: unknown;
}

export function writeTrapLine(claim: TrapClaim): {
  trap: string;
  firstPass: StampWord;
  postCheck: StampWord;
} {
  const trap = typeof claim.trap === 'string' && claim.trap.length > 0 ? claim.trap : 'row';
  return {
    trap,
    firstPass: writeStamp({ verdict: claim.first_pass_verdict }).stamp,
    postCheck: writeStamp({ verdict: claim.post_hal_verdict }).stamp,
  };
}

/** Ten fixture rows. Columns are first-pass and post-check. A miss is NOT_CHECKED. */
export function printTrapTable(claims: readonly TrapClaim[]): string {
  const lines = ['trap\tfirst-pass\tpost-check'];
  for (const claim of claims) {
    const row = writeTrapLine(claim);
    lines.push(`${row.trap}\t${row.firstPass}\t${row.postCheck}`);
  }
  return `${lines.join('\n')}\n`;
}
