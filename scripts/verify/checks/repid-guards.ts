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

/**
 * The guards this check requires, matched by what they GUARD rather than by an
 * exact name — and required to be ENABLED, not merely present.
 *
 * TWO DEFECTS THIS REPLACES, found 2026-09-23 when crosscheck went red on a PR
 * that changed one markdown file.
 *
 * 1. EXACT-NAME MATCH MISSED A DELIBERATE RENAME. The list named
 *    `trg_hal_penalty_guard`; the database has `trg_00_hal_penalty_guard`,
 *    enabled, on repid_score_events. Migration 2026-08-03-hal-penalty-guard-
 *    trigger-order.sql renamed it ON PURPOSE — PostgreSQL fires same-timing row
 *    triggers in NAME order, so the `00_` prefix makes "fires first" explicit
 *    instead of alphabetically accidental. The guard was never missing. This
 *    check reported a healthy database as a blocking failure and blocked every
 *    PR in the repo until someone read it. LESSONS rule 4: evidence outranks the
 *    label, and a trigger's name is a label.
 *
 * 2. THE WORSE ONE — IT DID NOT CHECK `tgenabled`, so it FAILED OPEN. The query
 *    was `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (…)`.
 *    `ALTER TABLE … DISABLE TRIGGER` leaves the row in pg_trigger with
 *    tgenabled='D', so a DISABLED penalty guard satisfied this check and the
 *    suite reported "both guards present". A check that cannot tell an armed
 *    guard from a disarmed one has not measured the thing it names.
 *
 * The pattern is anchored at the end (`%hal_penalty_guard`) so an ordering
 * prefix is tolerated while an unrelated trigger is not, and the table is
 * asserted too — a right-named trigger on the wrong table is not this guard.
 */
interface GuardSpec {
  /** Human name used in messages. */
  id: string;
  /** SQL LIKE pattern for tgname — tolerates an ordering prefix, nothing else. */
  pattern: string;
  /** The table it must sit on. */
  table: string;
}

const REQUIRED_GUARDS: GuardSpec[] = [
  { id: 'hal_penalty_guard', pattern: '%hal\\_penalty\\_guard', table: 'repid_score_events' },
  { id: 'repid_earned_floor', pattern: '%repid\\_earned\\_floor', table: 'repid_agents' },
];

export async function repidGuardsCheck(): Promise<CheckResult> {
  if (!getDb()) return skip(ID, TITLE, 'needs SUPABASE_URL + SUPABASE_SERVICE_KEY', true);

  let presentTriggers: string[];
  const missing: string[] = [];
  const disabled: string[] = [];
  let active: number, belowFloor: number;
  try {
    // tgenabled is SELECTED, not just the name: 'D' means disabled, and a
    // disabled guard is the failure this check exists to catch.
    const trg = await sqlExec<{ tgname: string; relname: string; tgenabled: string }>(
      `SELECT t.tgname, c.relname, t.tgenabled
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal`,
    );
    presentTriggers = trg.map(r => `${r.tgname}${r.tgenabled === 'D' ? ' (DISABLED)' : ''}`);
    for (const g of REQUIRED_GUARDS) {
      const suffix = g.pattern.replace(/^%/, '').replace(/\\_/g, '_');
      const hit = trg.find(r => r.tgname.endsWith(suffix) && r.relname === g.table);
      if (!hit) missing.push(`${g.id} (none matching *${suffix} on ${g.table})`);
      else if (hit.tgenabled === 'D') disabled.push(`${hit.tgname} on ${g.table}`);
    }

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

  const detail = { matched_guards: REQUIRED_GUARDS.map(g => g.id), missing_guards: missing, disabled_guards: disabled, active_agents: active, agents_below_floor: belowFloor };

  if (missing.length > 0) {
    return fail(ID, TITLE, `missing guard trigger(s): ${missing.join(', ')}`, true, detail);
  }
  // Distinct from missing on purpose: "someone disabled it" and "it was never
  // created" need different remedies, and collapsing them sends the reader to
  // the wrong one.
  if (disabled.length > 0) {
    return fail(ID, TITLE, `guard trigger(s) PRESENT BUT DISABLED: ${disabled.join(', ')}`, true, detail);
  }
  if (belowFloor > 0) {
    return fail(ID, TITLE, `${belowFloor}/${active} active agents BELOW earned floor`, true, detail);
  }
  return pass(ID, TITLE, `both guards present AND enabled; 0/${active} active agents below floor`, true, detail);
}
