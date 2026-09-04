#!/usr/bin/env node
/**
 * repid-recompute.mjs — reverse the HAL false-positive penalties, but only where
 * the ledger can prove what it did.
 *
 * VERDICT WHEN THIS WAS FIRST RUN IN ANGER [MEASURED 2026-09-04]: it proposes
 * NOTHING, and that is the correct answer rather than a failure of the tool.
 * The eligible set is EMPTY — not one agent both reconciles AND carries a
 * false-positive penalty. Keep the script anyway: it is the thing that
 * establishes that, and it is what re-establishes it if the class recurs.
 * `scripts/sql/repid-ledger-audit.sql` reproduces every number below from a
 * plain SQL connection, which is the only path most sessions have.
 *
 * WHY THIS EXISTS
 * ---------------
 * A `HAL_SCORE_EVENT` carrying `hal_decision = 'vetoed'` with
 * `hallucination_caught = false` is a penalty for a hallucination nobody
 * caught. Nothing new lands: `trg_00_hal_penalty_guard` is enabled on the
 * table. This script was written to ask whether the ones already applied
 * should be reversed.
 *
 * THE PREDICATE IS NARROWER THAN IT LOOKS, AND AN EARLIER DRAFT OF THIS HEADER
 * GOT ITS OWN NUMBERS WRONG. Measured by hal_decision:
 *
 *   vetoed  + caught=true    true positives, -430,260  (correct penalties)
 *   vetoed  + caught=false   THE DEFECT CLASS,  -252,990 recorded
 *   flagged + caught=false   delta 0 -- flagged NEVER docked a score
 *   clean   + caught=false   +5
 *
 * So `flagged` belongs in no damage total, and a figure of -475,618 that this
 * header once carried does not reproduce under any predicate the guard uses.
 * The recorded total is -252,990. Both halves matter: quoting the wide number
 * overstates the harm by ~88%, and quoting `flagged` as a penalty invents a
 * defect that the data says never cost anything.
 *
 * AND THE RECORDED TOTAL IS ITSELF NOT THE HARM. Of the 25,299 rows that
 * recorded a movement (-10 each, -252,990 in total), the NEXT event for the
 * same agent read back:
 *
 *   the post-penalty score   4,014 rows   -40,140   the penalty landed
 *   the PRE-penalty score   21,276 rows  -212,760   it never reached the table
 *
 * 84% of it evaporated. So this script reads `repid_after - repid_before` and
 * never `delta` -- and the audit goes one further and reads what the NEXT event
 * observed, because a before/after pair is a claim about a write, not evidence
 * of one. Same shape as `ecosystem_need_weight`: a value recorded as if it had
 * been used.
 *
 * WHY NOTHING IS ELIGIBLE
 * -----------------------
 * The whole defect class is a single window -- every false-positive penalty
 * that moved a score is dated May 2026, on 17 agents from the load-test
 * population, and the guard plus `apply_repid_score_event` closed it by July.
 * Those same 17 agents are exactly the ones whose ledgers do not reconcile
 * (thousands of chain breaks each, from the two-applier cutover). So the set
 * this script can defensibly rewrite and the set that was actually harmed do
 * not intersect, and no arithmetic makes them.
 *
 * The ledger has been self-consistent since July: 1 clamp-identity break in
 * 39,644 rows, against 82% of May's.
 *
 * WHAT IT WILL AND WILL NOT DO
 * ----------------------------
 * PHASE 1  reconcile   always runs. Per agent: does replaying the recorded
 *                      movements reproduce current_repid exactly?
 * PHASE 2  propose     only for agents that reconciled. Everything else is
 *                      reported as BLOCKED with its reason.
 * PHASE 3  apply       only with --apply, and only for reconciled agents.
 *                      Without it, nothing is written. Ever.
 *
 * A restoration would be an APPROXIMATION and the code says so rather than
 * implying otherwise: decay and the redemption modifier were computed at event
 * time from state that is not recorded, so removing a penalty cannot re-derive
 * what the later events would have done from a different baseline. What this
 * computes is "the same history with the false-positive movements removed and
 * the clamp re-applied" -- defensible and bounded, not a true counterfactual.
 * Anyone quoting it should quote that sentence with it.
 *
 * Usage:
 *   node scripts/repid-recompute.mjs             # audit + proposal, writes nothing
 *   node scripts/repid-recompute.mjs --json      # same, machine-readable
 *   node scripts/repid-recompute.mjs --apply     # writes, reconciled agents only
 *
 * Exit codes follow the repo convention: 0 VERIFIED, 2 NOT_CHECKED, other FAILED.
 */

import { createClient } from '@supabase/supabase-js';

const APPLY = process.argv.includes('--apply');
const JSON_OUT = process.argv.includes('--json');

const URL = process.env.SUPABASE_URL;
const KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY;

if (!URL || !KEY) {
  console.error('SUPABASE_URL and a service key are required. Nothing was read or written.');
  process.exit(2);
}

const REPID_MIN = 10;
const REPID_MAX = 10000;
const clamp = (n) => Math.max(REPID_MIN, Math.min(REPID_MAX, n));

/**
 * The defect predicate. Kept in one place so the audit and the fix cannot drift.
 *
 * `flagged` is kept in the predicate even though MEASURED 2026-09-04 it has
 * never docked a score (every flagged row carries delta 0). It is inert here --
 * callers pair this with `moved < 0`, so a zero-movement row is skipped either
 * way -- and leaving it in means a `flagged` that DOES start docking is caught
 * by this script rather than silently outside its scope. Do not read its
 * presence as a claim that flagged penalties exist.
 */
const isHalFalsePositive = (e) =>
  e.event_type === 'HAL_SCORE_EVENT' &&
  (e.hal_decision === 'flagged' || e.hal_decision === 'vetoed') &&
  e.hallucination_caught === false;

const db = createClient(URL, KEY, { auth: { persistSession: false } });

async function fetchAllEvents() {
  const page = 1000;
  let from = 0;
  const all = [];
  for (;;) {
    const { data, error } = await db
      .from('repid_score_events')
      .select('id, agent_id, event_type, delta, repid_delta_calculated, repid_before, repid_after, hal_decision, hallucination_caught, created_at')
      .order('agent_id', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + page - 1);
    if (error) throw new Error(`event read failed: ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < page) break;
    from += page;
  }
  return all;
}

/**
 * Fail with NOT_CHECKED, not with a stack trace.
 *
 * Most sessions that run this hold the documented dummy credentials
 * (`localhost:54321`), and node's global fetch does not read HTTPS_PROXY, so
 * the raw failure is an opaque `TypeError: fetch failed` that reads like a bug
 * in the query. An unreachable database is NOT_CHECKED and must say so: a
 * recompute that cannot see the ledger has not found "no changes", it has
 * found nothing.
 */
async function preflight() {
  const { error } = await db.from('repid_agents').select('id').limit(1);
  if (error) {
    console.error('NOT_CHECKED - could not read repid_agents.');
    console.error(`  ${error.message}`);
    console.error('  Nothing was read and nothing was written. This is not "no changes needed".');
    process.exit(2);
  }
}

async function main() {
  await preflight();
  const [events, agentsRes] = await Promise.all([
    fetchAllEvents(),
    db.from('repid_agents').select('id, agent_name, current_repid'),
  ]);
  if (agentsRes.error) throw new Error(`agent read failed: ${agentsRes.error.message}`);

  const live = new Map(agentsRes.data.map((a) => [a.id, a]));
  const byAgent = new Map();
  for (const e of events) {
    if (!byAgent.has(e.agent_id)) byAgent.set(e.agent_id, []);
    byAgent.get(e.agent_id).push(e);
  }

  const eligible = [];
  const blocked = [];

  for (const [agentId, evs] of byAgent) {
    const agent = live.get(agentId);
    if (!agent) {
      blocked.push({ agentId, name: '(no agent row)', reason: 'event references an agent that does not exist' });
      continue;
    }

    // ---- PHASE 1 — reconcile -------------------------------------------------
    // Replay the MOVEMENTS the ledger recorded. If that does not land exactly on
    // current_repid, this agent's history does not explain its score and we do
    // not get to rewrite that score from it.
    const usable = evs.filter((e) => e.repid_before !== null && e.repid_after !== null);
    if (usable.length === 0) {
      blocked.push({ agentId, name: agent.agent_name, reason: 'no event carries repid_before/repid_after' });
      continue;
    }

    let control = usable[0].repid_before;
    for (const e of usable) control = clamp(control + (e.repid_after - e.repid_before));

    if (control !== agent.current_repid) {
      blocked.push({
        agentId,
        name: agent.agent_name,
        reason: 'ledger does not reconcile',
        replayed: control,
        live: agent.current_repid,
        drift: agent.current_repid - control,
      });
      continue;
    }

    // ---- PHASE 2 — propose ---------------------------------------------------
    let treatment = usable[0].repid_before;
    let reversedMovement = 0;
    let reversedCount = 0;
    for (const e of usable) {
      const moved = e.repid_after - e.repid_before;
      if (isHalFalsePositive(e) && moved < 0) {
        reversedMovement += moved;
        reversedCount += 1;
        continue; // the penalty never should have landed
      }
      treatment = clamp(treatment + moved);
    }

    if (treatment !== agent.current_repid) {
      eligible.push({
        agentId,
        name: agent.agent_name,
        from: agent.current_repid,
        to: treatment,
        change: treatment - agent.current_repid,
        falsePositivesReversed: reversedCount,
        movementReversed: reversedMovement,
      });
    }
  }

  const report = {
    measured_at: new Date().toISOString(),
    events_read: events.length,
    agents_with_events: byAgent.size,
    eligible: eligible.length,
    blocked: blocked.length,
    total_repid_restored: eligible.reduce((s, a) => s + a.change, 0),
    mode: APPLY ? 'APPLY' : 'DRY RUN — nothing written',
  };

  if (JSON_OUT) {
    console.log(JSON.stringify({ report, eligible, blocked }, null, 2));
  } else {
    console.log('\nRepID recompute — HAL false-positive reversal\n');
    console.log(`  mode                 ${report.mode}`);
    console.log(`  events read          ${report.events_read}`);
    console.log(`  agents with events   ${report.agents_with_events}`);
    console.log(`  ELIGIBLE (reconciled)${String(report.eligible).padStart(6)}`);
    console.log(`  BLOCKED              ${String(report.blocked).padStart(6)}   <- not touched, reasons below`);
    console.log(`  RepID restored       ${report.total_repid_restored >= 0 ? '+' : ''}${report.total_repid_restored}\n`);

    if (eligible.length) {
      console.log('  ELIGIBLE — would change:');
      for (const a of eligible.sort((x, y) => y.change - x.change).slice(0, 25)) {
        console.log(
          `    ${String(a.name).padEnd(24)} ${String(a.from).padStart(6)} -> ${String(a.to).padStart(6)}` +
          `  (${a.change >= 0 ? '+' : ''}${a.change}, ${a.falsePositivesReversed} penalties reversed)`,
        );
      }
      if (eligible.length > 25) console.log(`    … ${eligible.length - 25} more`);
    }
    if (blocked.length) {
      console.log('\n  BLOCKED — deliberately untouched:');
      const byReason = {};
      for (const b of blocked) (byReason[b.reason] ??= []).push(b);
      for (const [reason, list] of Object.entries(byReason)) {
        console.log(`    ${list.length.toString().padStart(4)}  ${reason}`);
        for (const b of list.slice(0, 5)) {
          const extra = b.drift !== undefined ? ` (replayed ${b.replayed}, live ${b.live}, drift ${b.drift})` : '';
          console.log(`          ${b.name}${extra}`);
        }
        if (list.length > 5) console.log(`          … ${list.length - 5} more`);
      }
    }
    console.log('');
  }

  if (!APPLY) {
    console.log('DRY RUN. Nothing was written. Re-run with --apply to write the ELIGIBLE rows only.\n');
    return;
  }

  // ---- PHASE 3 — apply -----------------------------------------------------
  // Only reconciled agents. A blocked agent is never written, on any flag.
  let written = 0;
  for (const a of eligible) {
    const { error } = await db
      .from('repid_agents')
      .update({ current_repid: a.to })
      .eq('id', a.agentId)
      .eq('current_repid', a.from); // optimistic: refuse if it moved since we measured
    if (error) {
      console.error(`  FAILED ${a.name}: ${error.message}`);
      continue;
    }
    written += 1;
  }
  console.log(`\nAPPLIED to ${written} of ${eligible.length} eligible agents.`);
  console.log('tier is recomputed by trg_sync_tier on write — it is not set here.\n');
}

main().catch((e) => {
  console.error(`recompute aborted: ${e.message}`);
  process.exit(1);
});
