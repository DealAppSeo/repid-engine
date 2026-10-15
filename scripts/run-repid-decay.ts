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

/**
 * Should this run WRITE, or only report?
 *
 * `--apply` is the operator's flag and stays exactly as it was. `REPID_DECAY_APPLY`
 * exists so the Railway cron can be flipped between reporting and writing with ONE
 * variable, without editing a start command or shipping code — the same reversible
 * shape every other gate in this engine uses.
 *
 * DRY-RUN IS THE DEFAULT AND MUST STAY THE DEFAULT. This job walks every active
 * agent and lowers scores; a cron that silently starts writing because someone
 * mistyped a start command is precisely the failure the original author guarded
 * against by leaving it operator-run. Only the exact string 'true' enables writes —
 * '1', 'yes' and 'TRUE ' do not, because a half-recognised truthy value is how an
 * ambiguous flag becomes an unintended mutation.
 *
 * Exported for test; the parse is the whole safety property.
 */
export function shouldApply(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (argv.includes('--apply')) return true;
  return env.REPID_DECAY_APPLY === 'true';
}

/**
 * APPLY: write current_repid (tier auto-re-derives via trg_sync_tier), then log it.
 *
 * Each write runs ONCE (pgQuery write-once). The INSERT has no ON CONFLICT, so the old
 * `retries: 2` could log one decay twice. The UPDATE is a compare-and-set on the value this run
 * read (`AND current_repid = $3`): a score event landing in between is not clobbered, and the
 * log row is written only when the decay actually applied. A failure is per agent: logged
 * loudly, and the run moves on; the next run recomputes from fresh state. Exported for test.
 */
export async function applyDecays(
  decays: Array<{ row: Row; r: ReturnType<typeof decayRepid> }>,
  query: typeof pgQuery = pgQuery,
): Promise<{ applied: number; changed: number; failed: string[] }> {
  let applied = 0;
  let changed = 0;
  const failed: string[] = [];
  for (const { row, r } of decays) {
    if (r.decay_amount <= 0) continue;
    try {
      const hit = await query<{ id: string }>(
        `UPDATE repid_agents SET current_repid = $1
          WHERE id = $2 AND lifecycle_status = 'active' AND current_repid = $3
        RETURNING id`,
        [r.repid_after, row.id, row.current_repid],
        { label: 'repid-decay-apply-update' },
      );
      if (hit.length === 0) {
        changed++;
        console.warn(`[repid-decay] ${row.agent_name} (${row.id}): score or status changed since the read — skipped, next run recomputes`);
        continue;
      }
      // Log to repid_vesting_events (reused): earned=before, vested=after, cliff=now.
      await query(
        `INSERT INTO repid_vesting_events (agent_id, repid_earned, repid_vested, cliff_ends_at, vesting_complete)
         VALUES ($1, $2, $3, now(), false)`,
        [row.id, r.repid_before, r.repid_after],
        { label: 'repid-decay-log-event' },
      );
      applied++;
    } catch (e) {
      failed.push(row.agent_name ?? row.id);
      console.error(
        `[repid-decay] FAILED for ${row.agent_name} (${row.id}): ${(e as Error).message} ` +
          '(a timed-out write may still have committed; if the UPDATE did, its log row is missing)',
      );
    }
  }
  if (changed > 0) console.warn(`[repid-decay] ${changed} agent(s) skipped: changed since the read`);
  return { applied, changed, failed };
}

async function main() {
  const apply = shouldApply();
  const nowMs = Date.now();
  console.log(
    `[repid-decay] mode=${apply ? 'APPLY (writes)' : 'DRY-RUN (no writes)'} ` +
    `at ${new Date(nowMs).toISOString()} ` +
    `(source=${process.argv.includes('--apply') ? '--apply flag' : apply ? 'REPID_DECAY_APPLY=true' : 'default'})`,
  );

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

  const { applied, failed } = await applyDecays(decays);
  console.log(`\n[repid-decay] APPLIED decay to ${applied} agents; ${anomalies.length} skipped/flagged.`);
  if (failed.length > 0) {
    // Non-zero exit so the cron run reads as failed, after every other agent was attempted.
    throw new Error(`[repid-decay] ${failed.length} agent(s) failed to apply: ${failed.join(', ')}`);
  }
}

// Run only when executed directly. Without this guard the script executes — and
// calls process.exit — the moment anything IMPORTS it, which makes the apply-gate
// untestable and would let a stray import trigger a live decay pass. The gate is
// the safety property of promoting this to a cron, so it has to be reachable
// without running the job.
if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
