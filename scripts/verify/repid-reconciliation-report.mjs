#!/usr/bin/env node
/**
 * repid-reconciliation-report.mjs — READ-ONLY diagnostic for P0.5 RepID reconciliation.
 *
 * SAFE TO RUN. Performs ZERO writes. For the 12 trinity agents it prints a table:
 *   agent | db_current_repid | replay_reconciled(real_work_only=true)
 *         | replay_naive(real_work_only=false) | db_minus_reconciled_gap
 *         | events_applied | events_excluded
 *
 * This is what makes the reconciliation reviewable: it shows whether the cause-aware replay
 * reconstructs a DEFENSIBLE value versus the absurd-negative naive replay and versus the
 * manually-reset DB value.
 *
 * TWO EXECUTION PATHS (auto-detected):
 *   1. If migrations/2026-07-21-repid-reconciliation.sql has been APPLIED, the Postgres
 *      replay_score_events() RPC exists -> use it (fast, authoritative, uses the new index).
 *   2. If NOT applied yet (the normal pre-ratify case), fall back to a CLIENT-SIDE replay that
 *      MIRRORS the SQL exactly (same drill-churn filter, same per-event [10,10000] clamp), so the
 *      report is reviewable before the migration touches prod. This path is slower per agent
 *      until idx_repid_score_events_agent_created lands, but it needs no DDL.
 *
 * Env (same pattern as src/config.ts / scripts/generate-state-of-system.ts):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY || SUPABASE_SERVICE_KEY
 *
 * Usage:
 *   node scripts/verify/repid-reconciliation-report.mjs
 *   node scripts/verify/repid-reconciliation-report.mjs --baseline 1000
 *   node scripts/verify/repid-reconciliation-report.mjs --client   # force client-side replay
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_(ROLE_)KEY are required (read-only report).');
  process.exit(1);
}

const argv = process.argv.slice(2);
const baselineArgIdx = argv.indexOf('--baseline');
const BASELINE = baselineArgIdx >= 0 ? parseInt(argv[baselineArgIdx + 1], 10) : 1000;
const FORCE_CLIENT = argv.includes('--client');

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

const clamp = (v) => Math.max(10, Math.min(10000, v));

/**
 * Client-side mirror of the SQL is_repid_drill_churn(event_type, metadata).
 * MUST stay in lockstep with migrations/2026-07-21-repid-reconciliation.sql.
 * Returns true when the event is drill-churn to EXCLUDE from a real-work replay.
 */
function isRepidDrillChurn(eventType, metadata) {
  const m = metadata || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(m, k);
  const hasRealRef =
    has('task_id') || has('taskId') ||
    has('artifact') || has('artifact_url') ||
    has('tx_hash') || has('txHash') ||
    has('settlement') || has('settlement_id') ||
    (m.stakeProof && m.stakeProof.txHash != null) ||
    (m.x402Context != null);

  // RULE 1: unreferenced HAL_SCORE_EVENT churn (the peer-verify flood).
  if (eventType === 'HAL_SCORE_EVENT' && !hasRealRef) return true;

  return false; // default INCLUDE
}

/** Client-side replay mirroring replay_score_events(): per-event clamp, cause-aware skip. */
async function replayClientSide(agentId, realWorkOnly) {
  let v = clamp(BASELINE);
  let applied = 0;
  let excluded = 0;
  const PAGE = 1000;
  // Keyset pagination on (created_at, id) to walk in the same order the SQL uses.
  let lastCreated = null;
  let lastId = null;
  for (;;) {
    let q = sb
      .from('repid_score_events')
      .select('id, created_at, delta, event_type, metadata')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(PAGE);
    if (lastCreated != null) {
      // (created_at, id) > (lastCreated, lastId)
      q = q.or(`created_at.gt.${lastCreated},and(created_at.eq.${lastCreated},id.gt.${lastId})`);
    }
    const { data, error } = await q;
    if (error) throw new Error(`replay fetch failed for ${agentId}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data) {
      if (realWorkOnly && isRepidDrillChurn(row.event_type, row.metadata)) {
        excluded += 1;
        continue;
      }
      v = clamp(v + (Number(row.delta) || 0));
      applied += 1;
    }
    const last = data[data.length - 1];
    lastCreated = last.created_at;
    lastId = last.id;
    if (data.length < PAGE) break;
  }
  return { reconciled_repid: v, events_applied: applied, events_excluded: excluded };
}

/** RPC path — used when the migration has been applied. */
async function replayRpc(agentId, realWorkOnly) {
  const { data, error } = await sb.rpc('replay_score_events', {
    p_agent_id: agentId,
    p_baseline: BASELINE,
    p_real_work_only: realWorkOnly,
  });
  if (error) return { __rpcMissing: true, error };
  const row = Array.isArray(data) ? data[0] : data;
  return {
    reconciled_repid: row.reconciled_repid,
    events_applied: row.events_applied,
    events_excluded: row.events_excluded,
  };
}

async function detectRpc() {
  if (FORCE_CLIENT) return false;
  // Probe with a throwaway all-zero uuid; if the function is missing we get a specific error.
  const { error } = await sb.rpc('replay_score_events', {
    p_agent_id: '00000000-0000-0000-0000-000000000000',
    p_baseline: BASELINE,
    p_real_work_only: true,
  });
  if (!error) return true;
  // PostgREST reports a missing function (PGRST202) or "could not find function".
  const msg = (error.message || '').toLowerCase();
  if (msg.includes('function') || error.code === 'PGRST202' || msg.includes('schema cache')) return false;
  // Any other error (e.g. permissions) — assume RPC exists but surface later.
  return true;
}

async function main() {
  console.log('P0.5 RepID Reconciliation Report (READ-ONLY, no writes)');
  console.log(`baseline=${BASELINE}  url=${SUPABASE_URL.replace(/^https?:\/\//, '').split('.')[0]}...`);

  // The 12 core trinity agents (identity by agent_name; id is the uuid used in repid_score_events).
  const TRINITY = [
    'trinity-orch', 'trinity-w3c', 'trinity-shofet',
    'trinity-torch', 'trinity-veritas', 'trinity-gcm',
    'trinity-chesed', 'trinity-mel', 'trinity-apm',
    'trinity-sophia', 'trinity-nexus', 'trinity-hdm',
  ];

  const { data: agents, error: aerr } = await sb
    .from('repid_agents')
    .select('id, agent_name, current_repid')
    .in('agent_name', TRINITY);
  if (aerr) {
    console.error('failed to load trinity agents:', aerr.message);
    process.exit(1);
  }
  if (!agents || agents.length === 0) {
    console.error('no trinity agents found in repid_agents (agent_name match).');
    process.exit(1);
  }

  const useRpc = await detectRpc();
  console.log(`replay path: ${useRpc ? 'Postgres RPC replay_score_events() [migration APPLIED]' : 'client-side mirror [migration NOT applied]'}`);
  console.log('');

  const rows = [];
  for (const a of agents) {
    let real, naive;
    if (useRpc) {
      real = await replayRpc(a.id, true);
      naive = await replayRpc(a.id, false);
    } else {
      real = await replayClientSide(a.id, true);
      naive = await replayClientSide(a.id, false);
    }
    const db = a.current_repid;
    rows.push({
      agent: a.agent_name,
      db_current_repid: db,
      replay_reconciled: real.reconciled_repid,
      replay_naive: naive.reconciled_repid,
      db_minus_reconciled_gap: db != null ? db - real.reconciled_repid : null,
      events_applied: real.events_applied,
      events_excluded: real.events_excluded,
    });
    // progress line (stderr so the final table stays clean on stdout)
    process.stderr.write(`  ${a.agent_name}: db=${db} reconciled=${real.reconciled_repid} naive=${naive.reconciled_repid} excluded=${real.events_excluded}\n`);
  }

  rows.sort((x, y) => x.agent.localeCompare(y.agent));
  console.table(rows);

  // Compact machine-readable footer for handoff/report inclusion.
  console.log('\nJSON:', JSON.stringify(rows));
}

main().catch((e) => {
  console.error('report failed:', e.message || e);
  process.exit(1);
});
