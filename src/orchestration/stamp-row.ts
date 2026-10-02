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
