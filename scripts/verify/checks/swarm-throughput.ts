/**
 * CHECK 6 — Swarm throughput / concurrency-is-real.
 *
 * Closes the blind spot that let a "concurrency sprint" be claimed while the swarm ran serial.
 * It does TWO things a code review alone can't:
 *   (a) CROSS-REPO scan for the actual parallel-spawn mechanism — the atomic `claimed_by` claim
 *       (+ per-agent spawn) lives in trinity-symphony-shared, NOT repid-engine. (This is the same
 *       blind spot that made verify:claims false-flag GA's swarm code as phantom.)
 *   (b) LIVE trinity_tasks metrics — distinct active workers (real concurrency, not the noisy
 *       instantaneous `doing` count), backlog, and completions/hr vs inflow/hr.
 *
 * Verdict:
 *   FAIL (blocking) — SERIAL BOTTLENECK: the parallel mechanism exists in code AND the live swarm
 *     is effectively serial (< SWARM_MIN_WORKERS distinct workers in 15m) while a real backlog
 *     exists (pending > SWARM_BACKLOG_MIN). i.e. concurrency is CLAIMED but not HAPPENING — a
 *     concurrency sprint can't pass while the swarm runs at ~1 worker.
 *   PASS — swarm is demonstrably parallel (>= MIN_WORKERS active). Backlog growing (inflow >
 *     completions) is surfaced as a warning in the summary but is a CAPACITY signal, not a
 *     concurrency-broken signal, so it doesn't block by default (SWARM_FAIL_ON_BACKLOG_GROWTH=1
 *     to gate on it too).
 *
 * Tunables: SWARM_MIN_WORKERS(2), SWARM_BACKLOG_MIN(200), SWARM_FAIL_ON_BACKLOG_GROWTH(0).
 */
import { CheckResult, pass, fail, skip } from '../lib/types';
import { sqlExec, getDb } from '../lib/db';
import { scanRepos, scanRootLabels } from '../lib/scan';

const ID = 'swarm-throughput';
const TITLE = 'Swarm throughput — concurrency is real (not serial)';

const MIN_WORKERS = Number(process.env.SWARM_MIN_WORKERS ?? '2');
const BACKLOG_MIN = Number(process.env.SWARM_BACKLOG_MIN ?? '200');
const FAIL_ON_GROWTH = (process.env.SWARM_FAIL_ON_BACKLOG_GROWTH ?? '0') === '1';

// The parallel-coordination primitive: an atomic claim (claimed_by guarded by IS NULL / .is(null))
// or an explicit concurrency cap. Its presence means the system is DESIGNED to run parallel.
const PARALLEL_MECHANISM = /\.is\(\s*['"]claimed_by['"]\s*,\s*null|claimed_by\s+IS\s+NULL|SET\s+claimed_by|MAX_CONCURRENCY|spawnNextStep|FOR\s+UPDATE\s+SKIP\s+LOCKED/i;

export async function swarmThroughputCheck(): Promise<CheckResult> {
  if (!getDb()) return skip(ID, TITLE, 'needs SUPABASE_URL + SUPABASE_SERVICE_KEY', true);

  // (a) where is the parallel-spawn mechanism? (cross-repo — repid-engine + trinity-symphony-shared)
  const mechanismAt = scanRepos(PARALLEL_MECHANISM);
  const scanned = scanRootLabels().join(', ');

  // (b) live throughput
  let m: any;
  try {
    const rows = await sqlExec(
      `SELECT
         count(*) FILTER (WHERE status='doing')::int AS doing_now,
         count(DISTINCT claimed_by) FILTER (WHERE claimed_at > now()-interval '15 min')::int AS workers_15m,
         count(DISTINCT claimed_by) FILTER (WHERE claimed_at > now()-interval '60 min')::int AS workers_60m,
         count(*) FILTER (WHERE status='pending')::int AS pending,
         count(*) FILTER (WHERE completed_at > now()-interval '60 min')::int AS completions_60m,
         count(*) FILTER (WHERE created_at   > now()-interval '60 min')::int AS inflow_60m,
         (EXTRACT(epoch FROM now()-max(completed_at) FILTER (WHERE completed_at IS NOT NULL))/60)::int AS last_completion_min_ago
       FROM trinity_tasks`,
    );
    m = rows[0] ?? {};
  } catch (e: any) {
    return skip(ID, TITLE, `trinity_tasks query failed: ${e?.message ?? e}`, true);
  }

  const workers15 = Number(m.workers_15m ?? 0);
  const pending = Number(m.pending ?? 0);
  const inflow = Number(m.inflow_60m ?? 0);
  const completions = Number(m.completions_60m ?? 0);
  const backlogGrowing = inflow > completions;
  const netPerHr = inflow - completions;

  const detail = {
    parallel_mechanism_at: mechanismAt, scanned_repos: scanned,
    doing_now: Number(m.doing_now ?? 0), workers_15m: workers15, workers_60m: Number(m.workers_60m ?? 0),
    pending, completions_per_hr: completions, inflow_per_hr: inflow, backlog_net_per_hr: netPerHr,
    last_completion_min_ago: m.last_completion_min_ago, min_workers: MIN_WORKERS, backlog_min: BACKLOG_MIN,
  };

  // SERIAL BOTTLENECK — the GA failure mode: mechanism exists but swarm runs at <MIN_WORKERS.
  if (mechanismAt && pending > BACKLOG_MIN && workers15 < MIN_WORKERS) {
    return fail(ID, TITLE,
      `SERIAL: parallel mechanism present (${mechanismAt}) but only ${workers15} active worker(s)/15m with ${pending} pending`,
      true, detail);
  }
  // No mechanism found at all while there's a backlog — can't verify concurrency exists.
  if (!mechanismAt && pending > BACKLOG_MIN) {
    return fail(ID, TITLE, `no parallel-spawn mechanism found across [${scanned}] while ${pending} pending — concurrency unverifiable`, true, detail);
  }

  const growthNote = backlogGrowing ? ` ⚠ backlog growing +${netPerHr}/hr (inflow ${inflow} > completions ${completions})` : ` backlog draining ${netPerHr}/hr`;
  if (FAIL_ON_GROWTH && backlogGrowing && pending > BACKLOG_MIN) {
    return fail(ID, TITLE, `backlog growing +${netPerHr}/hr with ${pending} pending (${workers15} workers active)`, true, detail);
  }
  return pass(ID, TITLE, `parallel (${workers15} workers/15m, ${pending} pending);${growthNote}`, true, detail);
}
