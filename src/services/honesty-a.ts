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
  verdict?: string | null;
}

export interface HonestyARow {
  family: string;
  host: string;
  TRUE: number;
  FALSE: number;
  NOT_CHECKED: number;
}

export interface HonestyAReport {
  window_days: 7;
  status: 'counted' | 'NOT_CHECKED';
  source: typeof HONESTY_A_SOURCE;
  gap: string | null;
  rows: HonestyARow[] | null;
}

export function bucketVerdict(verdict: unknown): 'TRUE' | 'FALSE' | 'NOT_CHECKED' {
  if (verdict === 'TRUE') return 'TRUE';
  if (verdict === 'FALSE') return 'FALSE';
  return 'NOT_CHECKED';
}

export function aggregateHonestyA(votes: readonly HonestyVote[]): HonestyAReport {
  const buckets = new Map<string, HonestyARow>();
  for (const vote of votes) {
    const family = vote.family && vote.family.length > 0 ? vote.family : 'NOT_CHECKED';
    const host = vote.provider && vote.provider.length > 0 ? vote.provider : 'NOT_CHECKED';
    const key = `${family}\n${host}`;
    let row = buckets.get(key);
    if (!row) {
      row = { family, host, TRUE: 0, FALSE: 0, NOT_CHECKED: 0 };
      buckets.set(key, row);
    }
    row[bucketVerdict(vote.verdict)] += 1;
  }
  const rows = [...buckets.values()].sort((a, b) =>
    a.family === b.family ? a.host.localeCompare(b.host) : a.family.localeCompare(b.family),
  );
  return {
    window_days: HONESTY_A_WINDOW_DAYS,
    status: 'counted',
    source: HONESTY_A_SOURCE,
    gap: null,
    rows,
  };
}

export function honestyANotChecked(gap: string): HonestyAReport {
  return {
    window_days: HONESTY_A_WINDOW_DAYS,
    status: 'NOT_CHECKED',
    source: HONESTY_A_SOURCE,
    gap,
    rows: null,
  };
}
