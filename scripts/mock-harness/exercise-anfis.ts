/**
 * CC Sprint 9 Phase 4 — Exercise the ANFIS / hal routing surface.
 *
 * IMPORTANT (RULE-8 finding):
 *   hal_anfis_snapshots is a NETWORK-WIDE ABLATION/CHECKPOINT registry
 *   (snapshot_id, snapshot_version, anfis_weights jsonb), NOT a per-decision
 *   per-agent routing log. The Sprint 9 dispatcher assumed a per-agent snapshot
 *   table. This script adjusts to reality:
 *
 *     1. Read trinity_anfis_rules to confirm the rule corpus exists.
 *     2. Stage a network-level snapshot in hal_anfis_snapshots (clearly tagged)
 *        and clean up on exit.
 *     3. Surface that the per-decision routing path lives in hal_production_events
 *        (which IS per-agent and is the right table to exercise post-wakeup).
 *
 * No real ANFIS calls fire here — those require LLM provider keys + live trinity-*
 * runtime. This script proves the data-path shape only.
 */

import 'dotenv/config';
import { getDb } from '../liveness-probes/_shared';

(async () => {
  const db = getDb();

  console.log('[exercise-anfis] reading trinity_anfis_rules to verify rule corpus exists...');
  const { data: rules, error: rulesErr } = await db.from('trinity_anfis_rules').select('*').limit(5);
  if (rulesErr) { console.error('  rules read failed:', rulesErr.message); process.exit(1); }
  console.log(`  ${rules?.length ?? 0} rule rows visible`);

  console.log('[exercise-anfis] staging a snapshot to demonstrate the write path...');
  const tag = `cc-sprint-9-${Date.now()}`;
  const staged = {
    snapshot_id: tag,
    snapshot_version: 999,
    snapshot_hash: tag,
    anfis_weights: { staged: true, source: 'cc-sprint-9-exercise-anfis' },
    is_milestone: false,
    is_pre_registration: false,
    ablation_battery_run: false,
    milestone_description: 'cc-sprint-9 staged snapshot for write-path verification — safe to delete',
  };
  const { data: ins, error: insErr } = await db.from('hal_anfis_snapshots').insert(staged).select('id').single();
  if (insErr) {
    console.error(`  staged insert failed: ${insErr.message}`);
    process.exit(1);
  }
  const insertedId = (ins as any).id;
  console.log(`  staged snapshot id=${insertedId} snapshot_id=${tag}`);

  console.log('[exercise-anfis] cleanup...');
  await db.from('hal_anfis_snapshots').delete().eq('id', insertedId);

  console.log('[exercise-anfis] DONE');
  console.log('[exercise-anfis] NOTE: per-decision routing lives in hal_production_events (per-agent table).');
  console.log('[exercise-anfis] NEXT (after swarm wake-up): trigger a real HAL routing decision and');
  console.log('[exercise-anfis]   verify a row appears in hal_production_events for the calling agent.');
})().catch((e) => { console.error('exercise-anfis crashed:', e); process.exit(1); });
