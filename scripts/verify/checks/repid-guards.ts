/**
 * CHECK 5 — RepID protective guards present + floor invariant holds.
 *  (a) DB triggers trg_hal_penalty_guard (on repid_score_events) and trg_repid_earned_floor
 *      (on repid_agents) exist — the penalty gate + earned-floor clamp.
 *  (b) No lifecycle_status='active' agent sits below its earned tier floor (by peak_repid).
 * Catches a dropped guard trigger or an agent drained below the floor the trigger enforces.
 */
import { CheckResult, pass, fail, skip } from '../lib/types';
import { sqlExec, getDb } from '../lib/db';

const ID = 'repid-guards';
const TITLE = 'RepID guards (penalty + earned-floor triggers, no agent below floor)';

const REQUIRED_TRIGGERS = ['trg_hal_penalty_guard', 'trg_repid_earned_floor'];

export async function repidGuardsCheck(): Promise<CheckResult> {
  if (!getDb()) return skip(ID, TITLE, 'needs SUPABASE_URL + SUPABASE_SERVICE_KEY', true);

  let presentTriggers: string[];
  let active: number, belowFloor: number;
  try {
    const inList = REQUIRED_TRIGGERS.map(t => `'${t}'`).join(',');
    const trg = await sqlExec<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (${inList})`,
    );
    presentTriggers = trg.map(r => r.tgname);

    // floor by tier of peak_repid: PROBATIONARY 0 / EARNING 500 / ESTABLISHED 1000 / AUTONOMOUS 5000 / VETERAN 8000
    const floor = await sqlExec<{ active_total: number; below_floor: number }>(
      `SELECT count(*)::int AS active_total,
              count(*) FILTER (WHERE current_repid < (CASE
                WHEN COALESCE(peak_repid,current_repid) >= 8000 THEN 8000
                WHEN COALESCE(peak_repid,current_repid) >= 5000 THEN 5000
                WHEN COALESCE(peak_repid,current_repid) >= 1000 THEN 1000
                WHEN COALESCE(peak_repid,current_repid) >= 500 THEN 500 ELSE 0 END))::int AS below_floor
       FROM repid_agents WHERE lifecycle_status='active'`,
    );
    active = Number(floor[0]?.active_total ?? -1);
    belowFloor = Number(floor[0]?.below_floor ?? -1);
  } catch (e: any) {
    return skip(ID, TITLE, `DB query failed: ${e?.message ?? e}`, true);
  }

  const missingTriggers = REQUIRED_TRIGGERS.filter(t => !presentTriggers.includes(t));
  const detail = { present_triggers: presentTriggers, missing_triggers: missingTriggers, active_agents: active, agents_below_floor: belowFloor };

  if (missingTriggers.length > 0) {
    return fail(ID, TITLE, `missing guard trigger(s): ${missingTriggers.join(', ')}`, true, detail);
  }
  if (belowFloor > 0) {
    return fail(ID, TITLE, `${belowFloor}/${active} active agents BELOW earned floor`, true, detail);
  }
  return pass(ID, TITLE, `both guards present; 0/${active} active agents below floor`, true, detail);
}
