/**
 * First pass vs HAL on one quorum vote row.
 *
 * The row stores family, host, and the two passes. A post-HAL value is refused
 * unless the first pass is already TRUE or FALSE with a timestamp. A missing
 * first pass is stored as null. It is not 0.
 *
 * Inserts only when HAL_QUORUM_RECEIPT_ENABLED is the exact string `true`.
 * Unset, TRUE, on, and 1 do not insert. This module does not set that variable.
 */

export interface PassVoteInput {
  receipt_id: number;
  family: string;
  host: string;
  first_pass_verdict?: unknown;
  first_pass_at?: unknown;
  post_hal_verdict?: unknown;
  post_hal_at?: unknown;
}

export interface StoredPassVote {
  receipt_id: number;
  provider: string;
  family: string;
  host: string;
  verdict: 'TRUE' | 'FALSE' | 'NOT_CHECKED';
  first_pass_verdict: 'TRUE' | 'FALSE' | null;
  first_pass_at: string | null;
  post_hal_verdict: 'TRUE' | 'FALSE' | null;
  post_hal_at: string | null;
}

export type PassVoteRefusal = 'post-hal-without-first-pass';

export interface PassVoteWriteResult {
  written: boolean;
  skippedReason?: 'flag-off' | PassVoteRefusal | 'insert-error';
}

type VoteInsertClient = {
  from: (table: string) => {
    insert: (row: StoredPassVote) => Promise<{ error: { message: string } | null }>;
  };
};

function exactTrue(env: Record<string, string | undefined>): boolean {
  return env.HAL_QUORUM_RECEIPT_ENABLED === 'true';
}

function closedVerdict(value: unknown): 'TRUE' | 'FALSE' | null {
  if (value === 'TRUE' || value === 'FALSE') return value;
  return null;
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

function attempted(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Pure row. Post-HAL without a completed first pass is refused and returns no row,
 * so a caller cannot insert the rejected shape.
 */
export function normalizePassVote(
  input: PassVoteInput,
): { ok: true; row: StoredPassVote } | { ok: false; skippedReason: PassVoteRefusal } {
  const firstVerdict = closedVerdict(input.first_pass_verdict);
  const firstAt = timestamp(input.first_pass_at);
  const postVerdict = closedVerdict(input.post_hal_verdict);
  const postAt = timestamp(input.post_hal_at);
  const firstComplete = firstVerdict !== null && firstAt !== null;
  const postAttempt = attempted(input.post_hal_verdict) || attempted(input.post_hal_at);
  if (postAttempt && !firstComplete) {
    return { ok: false, skippedReason: 'post-hal-without-first-pass' };
  }
  return {
    ok: true,
    row: {
      receipt_id: input.receipt_id,
      provider: input.host,
      family: input.family,
      host: input.host,
      verdict: firstVerdict ?? 'NOT_CHECKED',
      first_pass_verdict: firstVerdict,
      first_pass_at: firstComplete ? firstAt : null,
      post_hal_verdict: firstComplete ? postVerdict : null,
      post_hal_at: firstComplete && postVerdict !== null ? postAt : null,
    },
  };
}

export async function writePassVote(
  client: VoteInsertClient,
  input: PassVoteInput,
  env: Record<string, string | undefined> = process.env,
): Promise<PassVoteWriteResult> {
  if (!exactTrue(env)) return { written: false, skippedReason: 'flag-off' };
  const normalized = normalizePassVote(input);
  if (!normalized.ok) return { written: false, skippedReason: normalized.skippedReason };
  const { error } = await client.from('hal_quorum_validator_votes').insert(normalized.row);
  if (error) return { written: false, skippedReason: 'insert-error' };
  return { written: true };
}
