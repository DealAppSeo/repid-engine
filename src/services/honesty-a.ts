/**
 * Honesty A — last-7-day TRUE / FALSE / NOT_CHECKED counts by family and host.
 *
 * Host is the fact-check provider name (`hal_quorum_validator_votes.provider`).
 * That table is what fact-check's quorum writer stores. `llm_call_log` has no
 * verdict column (provider, model, latency, status, task_hint). Latency is not
 * a verdict and is never read here.
 *
 * UNCERTAIN, ERROR, blank, and anything else are NOT_CHECKED. A failed or
 * truncated read is NOT_CHECKED with `rows: null`, not a zero that looks measured.
 */

export const HONESTY_A_WINDOW_DAYS = 7;
export const HONESTY_A_PAGE_CAP = 1000;
export const HONESTY_A_SOURCE = 'hal_quorum_validator_votes';

export const HONESTY_A_LLM_LOG_GAP =
  'llm_call_log has no verdict column. Counts are not taken from latency or from status.';

export interface HonestyVote {
  family?: string | null;
  provider?: string | null;
  host?: string | null;
  verdict?: string | null;
  first_pass_verdict?: unknown;
  post_hal_verdict?: unknown;
}

export interface PassCounts {
  TRUE: number;
  FALSE: number;
  NOT_CHECKED: number;
}

export interface PassReading {
  verdict: 'TRUE' | 'FALSE' | null;
  status: 'counted' | 'NOT_CHECKED';
}

export interface HonestyARow {
  family: string;
  host: string;
  TRUE: number;
  FALSE: number;
  NOT_CHECKED: number;
  first_pass: PassCounts;
  post_hal: PassCounts;
}

export interface HonestyAReport {
  window_days: 7;
  status: 'counted' | 'NOT_CHECKED';
  source: typeof HONESTY_A_SOURCE;
  /**
   * True only when HAL_QUORUM_RECEIPT_ENABLED is the exact string `true`.
   * Unset is false. This does not change the writer, and it does not turn it on.
   */
  writer_enabled: boolean;
  gap: string | null;
  rows: HonestyARow[] | null;
}

/** Exact-string reading. `TRUE`, `on`, and `1` are false here. */
export function voteWriterEnabled(env: Record<string, string | undefined>): boolean {
  return env.HAL_QUORUM_RECEIPT_ENABLED === 'true';
}

export function bucketVerdict(verdict: unknown): 'TRUE' | 'FALSE' | 'NOT_CHECKED' {
  if (verdict === 'TRUE') return 'TRUE';
  if (verdict === 'FALSE') return 'FALSE';
  return 'NOT_CHECKED';
}

/**
 * A missing first pass, and the number 0, are NOT_CHECKED. The verdict is null.
 * It is not 0, so an absent pass cannot be scored as a measured zero.
 */
export function readPassVerdict(verdict: unknown): PassReading {
  if (verdict === 'TRUE' || verdict === 'FALSE') {
    return { verdict, status: 'counted' };
  }
  return { verdict: null, status: 'NOT_CHECKED' };
}

function emptyPasses(): { first_pass: PassCounts; post_hal: PassCounts } {
  return {
    first_pass: { TRUE: 0, FALSE: 0, NOT_CHECKED: 0 },
    post_hal: { TRUE: 0, FALSE: 0, NOT_CHECKED: 0 },
  };
}

function addPass(counts: PassCounts, verdict: unknown): void {
  const reading = readPassVerdict(verdict);
  if (reading.status === 'NOT_CHECKED' || reading.verdict === null) {
    counts.NOT_CHECKED += 1;
    return;
  }
  counts[reading.verdict] += 1;
}

export function aggregateHonestyA(
  votes: readonly HonestyVote[],
  env: Record<string, string | undefined> = process.env,
): HonestyAReport {
  const buckets = new Map<string, HonestyARow>();
  for (const vote of votes) {
    const family = vote.family && vote.family.length > 0 ? vote.family : 'NOT_CHECKED';
    const namedHost = vote.host && vote.host.length > 0 ? vote.host : vote.provider;
    const host = namedHost && namedHost.length > 0 ? namedHost : 'NOT_CHECKED';
    const key = `${family}\n${host}`;
    let row = buckets.get(key);
    if (!row) {
      row = { family, host, TRUE: 0, FALSE: 0, NOT_CHECKED: 0, ...emptyPasses() };
      buckets.set(key, row);
    }
    row[bucketVerdict(vote.verdict)] += 1;
    addPass(row.first_pass, vote.first_pass_verdict);
    addPass(row.post_hal, vote.post_hal_verdict);
  }
  const rows = [...buckets.values()].sort((a, b) =>
    a.family === b.family ? a.host.localeCompare(b.host) : a.family.localeCompare(b.family),
  );
  return {
    window_days: HONESTY_A_WINDOW_DAYS,
    status: 'counted',
    source: HONESTY_A_SOURCE,
    writer_enabled: voteWriterEnabled(env),
    gap: null,
    rows,
  };
}

export function honestyANotChecked(
  gap: string,
  env: Record<string, string | undefined> = process.env,
): HonestyAReport {
  return {
    window_days: HONESTY_A_WINDOW_DAYS,
    status: 'NOT_CHECKED',
    source: HONESTY_A_SOURCE,
    writer_enabled: voteWriterEnabled(env),
    gap,
    rows: null,
  };
}
