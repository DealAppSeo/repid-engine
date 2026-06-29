/**
 * Operator script — RepID dormancy decay (sprint 2026-05-29, Part A).
 *
 * Usage:
 *   ts-node scripts/run-repid-decay.ts            # DRY-RUN (default): prints the diff, writes NOTHING
 *   ts-node scripts/run-repid-decay.ts --apply     # writes current_repid (tier auto-re-derives) + logs
 *
 * SCOPE (non-negotiable): operates on lifecycle_status='active' ONLY. The SELECT
 * filters to active; decayRepid() re-checks status as defense-in-depth.
 *
 * SKIP-AND-FLAG (never silent-decay): any agent that is non-active (guard) or has
 * NULL last_active_at (indeterminate idleness) or NULL decay_rate is SKIPPED and
 * surfaced in the anomalies list — never decayed.
 *
 * FLOOR: RepID never decays below the agent's current tier lower bound.
 * DECAYING-DECAY: rate eases with sustained activity (see repid-decay.ts).
 *
 * Cadence: weekly, OPERATOR-RUN. Designed cron-ready but NOT auto-deployed —
 * see the "promote to cron" checklist in the sprint report (Sean-only).
 *
 * On --apply, each decayed agent is logged to repid_vesting_events (reused, not
 * invented): repid_earned = repid_before, repid_vested = repid_after,
 * cliff_ends_at = now. (No event_type column exists — discriminability caveat
 * flagged in the report.) pgQuery on all DB access [rule:8].
 */
import { pgQuery } from '../src/db/direct-pg';
import { decayRepid, tierName, type DecayAgentInput } from '../src/services/repid-decay';

interface Row extends DecayAgentInput {
  id: string;
  agent_name: string;
  current_repid: number;
  decay_rate: number | null;
  last_active_at: string | null;
  created_at: string | null;
  lifecycle_status: string;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const nowMs = Date.now();
  console.log(`[repid-decay] mode=${apply ? 'APPLY (writes)' : 'DRY-RUN (no writes)'} at ${new Date(nowMs).toISOString()}`);

  // ACTIVE-ONLY select [rule:8 direct pg].
  const rows = await pgQuery<Row>(
    `SELECT id, agent_name, current_repid, decay_rate, last_active_at, created_at, lifecycle_status
       FROM repid_agents
      WHERE lifecycle_status = 'active'
      ORDER BY current_repid DESC`,
    [],
    { retries: 2, label: 'repid-decay-select-active' },
  );
  console.log(`[repid-decay] ${rows.length} active agents selected`);

  const decays: Array<{ row: Row; r: ReturnType<typeof decayRepid> }> = [];
  const anomalies: Array<{ agent: string; id: string; current_repid: number; reason: string }> = [];

  for (const row of rows) {
    // Defense-in-depth: never decay a non-active row even if one slipped through.
    if (row.lifecycle_status !== 'active') {
      anomalies.push({ agent: row.agent_name, id: row.id, current_repid: row.current_repid, reason: `non-active status '${row.lifecycle_status}' in active select — SKIPPED` });
      continue;
    }
    const r = decayRepid(row, nowMs);
    if (r.skip) {
      anomalies.push({ agent: row.agent_name, id: row.id, current_repid: row.current_repid, reason: `skip:${r.skip}` });
      continue;
    }
    decays.push({ row, r });
  }

  // Preview table.
  console.log('\n--- DECAY PREVIEW (active, decayable) ---');
  console.log('agent'.padEnd(22), 'before', '→ after', 'Δ', 'weeks_idle', 'eff_rate', 'tier');
  let totalDecay = 0;
  for (const { r } of decays) {
    if (r.decay_amount > 0) totalDecay += r.decay_amount;
    console.log(
      (r.agent_name ?? '').padEnd(22),
      String(r.repid_before).padStart(6),
      '→', String(r.repid_after).padStart(6),
      String(-r.decay_amount).padStart(5),
      r.weeks_idle.toFixed(2).padStart(6),
      r.effective_rate.toFixed(5),
      `${tierName(r.repid_before)}→${tierName(r.repid_after)}${r.floored ? ' [FLOOR]' : ''}`,
    );
  }
  console.log(`\n[repid-decay] ${decays.filter(d => d.r.decay_amount > 0).length} agents would decay, total RepID eroded: ${totalDecay}`);

  // Skip-and-flag surface.
  console.log(`\n--- ANOMALIES / SKIPS (${anomalies.length}) — surfaced, NOT decayed ---`);
  for (const a of anomalies) console.log(`  ${a.agent.padEnd(22)} repid=${a.current_repid}  ${a.reason}  (${a.id})`);

  if (!apply) {
    console.log('\n[repid-decay] DRY-RUN complete — no writes. Re-run with --apply to persist.');
    return;
  }

  // APPLY: write current_repid (tier auto-re-derives via trg_sync_tier) + log.
  let applied = 0;
  for (const { row, r } of decays) {
    if (r.decay_amount <= 0) continue;
    await pgQuery(
      `UPDATE repid_agents SET current_repid = $1 WHERE id = $2 AND lifecycle_status = 'active'`,
      [r.repid_after, row.id],
      { retries: 2, label: 'repid-decay-apply-update' },
    );
    // Log to repid_vesting_events (reused): earned=before, vested=after, cliff=now.
    await pgQuery(
      `INSERT INTO repid_vesting_events (agent_id, repid_earned, repid_vested, cliff_ends_at, vesting_complete)
       VALUES ($1, $2, $3, now(), false)`,
      [row.id, r.repid_before, r.repid_after],
      { retries: 2, label: 'repid-decay-log-event' },
    );
    // Write DECAY audit event to repid_score_events (closing the unlogged update gap)
    await pgQuery(
      `INSERT INTO repid_score_events (
         agent_id, event_type, delta, repid_before, repid_after, repid_delta_applied, idempotency_key, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        row.id,
        'DECAY',
        -r.decay_amount,
        r.repid_before,
        r.repid_after,
        -r.decay_amount,
        `decay:${row.id}:${new Date(nowMs).toISOString().substring(0, 10)}`,
        JSON.stringify({
          reason: 'Dormancy decay',
          weeks_idle: r.weeks_idle,
          effective_rate: r.effective_rate,
          floored: r.floored
        })
      ],
      { retries: 2, label: 'repid-decay-log-score-event' }
    );
    applied++;
  }
  console.log(`\n[repid-decay] APPLIED decay to ${applied} agents; ${anomalies.length} skipped/flagged.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
