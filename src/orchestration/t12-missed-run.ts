/**
 * t12-missed-run.ts — has the supervisor actually been running?
 *
 * Reads GitHub's own record of the workflow, never anything the supervisor writes about itself, so a
 * supervisor that silently stopped cannot report that it is fine. Run it from anywhere that is not the
 * supervisor. An unreachable record is NOT_CHECKED, never OK.
 */
export interface RunRow { status: string; conclusion: string | null; created_at: string }
export type MissedRunVerdict = 'OK' | 'MISSED' | 'FAILING' | 'NOT_ARMED' | 'NOT_CHECKED';
export interface MissedRunReport { verdict: MissedRunVerdict; exit: 0 | 1 | 2; reason: string; last_run_at: string | null }

const FAILING_RUNS = 3;

export function judgeRuns(rows: readonly RunRow[] | null, nowMs: number, maxAgeMinutes: number, armed: boolean): MissedRunReport {
  if (rows === null) return { verdict: 'NOT_CHECKED', exit: 2, reason: "GitHub's record could not be read", last_run_at: null };
  const ordered = [...rows].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const last = ordered[0]?.created_at ?? null;
  if (!armed) return { verdict: 'NOT_ARMED', exit: 0, reason: 'the schedule is not armed, so a missing run means nothing', last_run_at: last };
  if (!last) return { verdict: 'MISSED', exit: 1, reason: 'armed, but there is no run on record', last_run_at: null };
  const age = (nowMs - Date.parse(last)) / 60_000;
  if (age > maxAgeMinutes) return { verdict: 'MISSED', exit: 1, reason: `the last run started ${Math.round(age)} minutes ago; the limit is ${maxAgeMinutes}`, last_run_at: last };
  const finished = ordered.filter((r) => r.status === 'completed').slice(0, FAILING_RUNS);
  if (finished.length === FAILING_RUNS && finished.every((r) => r.conclusion !== 'success')) {
    return { verdict: 'FAILING', exit: 1, reason: `the last ${FAILING_RUNS} runs did not succeed`, last_run_at: last };
  }
  return { verdict: 'OK', exit: 0, reason: `the last run started ${Math.round(age)} minutes ago`, last_run_at: last };
}
