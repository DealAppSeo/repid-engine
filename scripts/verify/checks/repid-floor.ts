/**
 * CHECK — RepID drain signature: no ACTIVE trinity agent is pinned EXACTLY at its tier floor while
 * its peak_repid is >= 2x that floor. That pattern is the fingerprint of the ungated direct-apply
 * penalty (S-DRAIN Phase 3): the blind extractor vetoes true answers, fires -10, and drags
 * current_repid down to the floor even though the agent earned 2-3x more (peak).
 *
 * This reads LIVE prod state, so until the Phase 3 gate is deployed AND agents recover via positive
 * events, it will legitimately FAIL — that is a real finding, not a harness bug (D-059). Phase it in
 * with WARN_ONLY=repid-floor until a clean post-deploy window, then promote to blocking.
 *
 * Threshold note (D-059, two-sided): the sprint named "peak ≥ 2× floor", but the live drain on
 * 2026-06-03 sits at peak 1.03–1.87× floor (e.g. trinity-nexus 500/935 = 1.87×, trinity-w3c
 * 1000/1840 = 1.84×) — every drained agent is UNDER 2×, so a 2× gate passes vacuously and misses the
 * exact drain this sprint fixes. We therefore default the gate to 1.5× (env FLOOR_PEAK_RATIO) so the
 * check actually catches the documented signature; set FLOOR_PEAK_RATIO=2 to match the literal spec.
 */
import { CheckResult, pass, fail, skip } from '../lib/types';
import { sqlExec, getDb } from '../lib/db';

const ID = 'repid-floor';
const RATIO = Number(process.env.FLOOR_PEAK_RATIO ?? '1.5');
const TITLE = `RepID drain signature (no active trinity agent pinned at floor with peak ≥ ${RATIO}× floor)`;

export async function repidFloorCheck(): Promise<CheckResult> {
  if (!getDb()) return skip(ID, TITLE, 'needs SUPABASE_URL + SUPABASE_SERVICE_KEY', true);

  // NOTE: exec_sql only returns rows for queries that START with 'select' (it routes anything else
  // through EXECUTE-without-capture). A leading WITH/CTE silently returns []. So this is a single
  // SELECT with the tier-floor CASE inlined (repeated rather than CTE'd) to stay row-returning.
  const FLOOR_CASE =
    `(CASE WHEN COALESCE(peak_repid,current_repid) >= 8000 THEN 8000
           WHEN COALESCE(peak_repid,current_repid) >= 5000 THEN 5000
           WHEN COALESCE(peak_repid,current_repid) >= 1000 THEN 1000
           WHEN COALESCE(peak_repid,current_repid) >= 500  THEN 500 ELSE 0 END)`;
  let pinned: Array<{ agent_name: string; current_repid: number; peak_repid: number; floor: number }>;
  try {
    pinned = await sqlExec(
      `SELECT agent_name, current_repid, peak_repid, ${FLOOR_CASE} AS floor
       FROM repid_agents
       WHERE lifecycle_status='active' AND agent_name LIKE 'trinity-%'
         AND ${FLOOR_CASE} > 0
         AND current_repid = ${FLOOR_CASE}
         AND peak_repid >= ${RATIO} * ${FLOOR_CASE}
       ORDER BY peak_repid DESC`,
    );
  } catch (e: any) {
    return skip(ID, TITLE, `DB query failed: ${e?.message ?? e}`, true);
  }

  const detail = { pinned_count: pinned.length, pinned_agents: pinned.slice(0, 12) };
  if (pinned.length > 0) {
    const ex = pinned[0]!;
    return fail(ID, TITLE,
      `${pinned.length} active trinity agent(s) pinned at floor with peak ≥ ${RATIO}× (e.g. ${ex.agent_name}: ${ex.current_repid}/${ex.peak_repid})`,
      true, detail);
  }
  return pass(ID, TITLE, `no active trinity agent pinned at floor with peak ≥ ${RATIO}× floor`, true, detail);
}
