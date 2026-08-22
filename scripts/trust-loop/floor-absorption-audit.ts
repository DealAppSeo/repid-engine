/**
 * floor-absorption-audit.ts — how much of the ledger describes movements that
 * never happened?
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE BUG THIS MEASURES
 * ════════════════════════════════════════════════════════════════════════════════
 * `apply_repid_score_event` wrote `current_repid`, and `trg_repid_earned_floor`
 * then raised it back to `tier_lower_bound(peak_repid)`. By then the score event
 * had already stamped `repid_after` and `repid_delta_applied` from its own
 * arithmetic. So for any agent sitting on its tier floor, the ledger recorded a
 * penalty that the agent never actually paid — and `agent_repid_history`
 * recorded the same false delta.
 *
 * Fixed going forward on 2026-08-21 by reading back what actually landed. This
 * script answers the other half: **how much history is affected.**
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * WHY THE OBVIOUS DETECTOR IS WRONG — BOTH OBVIOUS DETECTORS
 * ════════════════════════════════════════════════════════════════════════════════
 * Two plausible queries were tried first and both are unusable. They are recorded
 * here because the next person will reach for them too.
 *
 * **1. "`repid_after` below the agent's floor."** `peak_repid` is a high-water
 * mark that only ever rises, so this compares an April event against TODAY'S
 * floor. An agent that peaked in August makes every earlier event look
 * impossible. It over-counts enormously and the number means nothing.
 *
 * **2. The same thing with the peak reconstructed per event.** Better, and still
 * unusable, because it assumes the floor trigger existed for the whole history.
 * There is **no floor migration in the tracked migration history**, so the
 * trigger cannot be dated, and events predating it were legitimately below a
 * floor that did not yet exist.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * THE DETECTOR THAT WORKS
 * ════════════════════════════════════════════════════════════════════════════════
 * Consecutive events on one agent, where the ledger says one left the score at X
 * and the next says it STARTED from something higher. Something raised it in
 * between, and that is visible without knowing when any trigger arrived.
 *
 * A rise alone is not proof of the floor — other writers touch `current_repid`
 * too — so the rises that landed **exactly on the agent's tier floor** are
 * counted separately. That is the floor's signature; the remainder is something
 * else and is reported as such rather than folded in to make the number bigger.
 *
 * **The floor-shaped count is a LOWER BOUND.** It compares against today's peak,
 * so an agent whose peak has risen since will not match even where the floor did
 * absorb the penalty. Under-counting is the right direction for a number that
 * will be quoted.
 *
 * ════════════════════════════════════════════════════════════════════════════════
 * USAGE
 * ════════════════════════════════════════════════════════════════════════════════
 *   npx ts-node scripts/trust-loop/floor-absorption-audit.ts
 *
 * Exit codes, matching this repo's vocabulary:
 *   0  VERIFIED     — no floor-shaped absorption found in history
 *   1  FAILED       — absorption found; the ledger overstates penalties for those agents
 *   2  NOT_CHECKED  — could not query
 *
 * Read-only. It writes nothing and repairs nothing: what the remediation should
 * be is a policy question that rides on the L3 decision, because a ledger
 * rewrite and a floor-shape change want to happen in the same migration.
 */
import { db } from '../../src/db';

const SQL = `
with seq as (
  select e.agent_id, e.created_at, e.repid_after,
         lead(e.repid_before) over (partition by e.agent_id order by e.created_at, e.id) as next_before
  from public.repid_score_events e
  where e.is_shadow = false and e.repid_after is not null and e.repid_before is not null
),
rose as (
  select s.*, public.tier_lower_bound(a.peak_repid) as floor_now
  from seq s join public.repid_agents a on a.id = s.agent_id
  where s.next_before is not null and s.next_before > s.repid_after
)
select
  count(*)                                                        as rises_between_events,
  count(distinct agent_id)                                        as agents_with_a_rise,
  count(*) filter (where next_before = floor_now)                 as floor_shaped_rises,
  count(distinct agent_id) filter (where next_before = floor_now) as agents_floor_shaped,
  min(created_at) filter (where next_before = floor_now)          as floor_shaped_earliest,
  max(created_at) filter (where next_before = floor_now)          as floor_shaped_latest
from rose;
`;

interface Row {
  rises_between_events: number;
  agents_with_a_rise: number;
  floor_shaped_rises: number;
  agents_floor_shaped: number;
  floor_shaped_earliest: string | null;
  floor_shaped_latest: string | null;
}

async function main(): Promise<void> {
  const { data, error } = await db.rpc('run_sql', { query: SQL }).single<Row>();

  if (error || !data) {
    // An unreachable database is an absence, never a clean bill of health.
    console.error(`NOT_CHECKED — could not run the audit: ${error?.message ?? 'no rows'}`);
    process.exit(2);
  }

  const d = data as Row;
  console.log('floor absorption audit');
  console.log(`  rises between events        ${d.rises_between_events} across ${d.agents_with_a_rise} agents`);
  console.log(`  of those, floor-shaped      ${d.floor_shaped_rises} across ${d.agents_floor_shaped} agents`);
  if (d.floor_shaped_earliest) {
    console.log(`  floor-shaped window        ${String(d.floor_shaped_earliest).slice(0, 10)} .. ${String(d.floor_shaped_latest).slice(0, 10)}`);
  }
  console.log('');
  console.log('  floor-shaped is a LOWER BOUND: it compares against today\'s peak, so an');
  console.log('  agent whose peak has risen since will not match even where absorption');
  console.log('  happened. The non-floor-shaped remainder has other causes and is not');
  console.log('  evidence of this bug.');
  console.log('');

  if (d.floor_shaped_rises > 0) {
    console.log('FAILED — the ledger overstates penalties for these agents.');
    console.log('        Any analysis of ratchet insulation over this window reads a ledger');
    console.log('        that asserts the penalties landed. Remediation rides on the L3');
    console.log('        decision: a ledger rewrite and a floor-shape change belong in one');
    console.log('        migration, not two.');
    process.exit(1);
  }
  console.log('VERIFIED — no floor-shaped absorption in history.');
  process.exit(0);
}

main().catch((e) => {
  console.error(`NOT_CHECKED — audit threw: ${e?.message ?? e}`);
  process.exit(2);
});
