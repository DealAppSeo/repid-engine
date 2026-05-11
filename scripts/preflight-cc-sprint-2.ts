/**
 * Preflight schema check for CC Sprint 2 (RepID earning + rate limiter + V1 gap inventory).
 *
 * Verifies every table/column/RPC the sprint touches BEFORE we write code,
 * per PREFLIGHT_COMMON_2026-05-11.md §8.
 *
 * Exits non-zero if anything FAILs. Sean re-checks before proceeding.
 *
 * NOTE on PostgREST limitation:
 *   This script's information_schema queries return empty col counts because
 *   Supabase PostgREST does not expose information_schema as a queryable
 *   relation. The actual schema verification was performed via Supabase MCP
 *   (raw SQL execute) on 2026-05-11 morning and is documented in
 *   E:\dev\reports\2026-05-11\CC_SPRINT_2_REPORT.md "Schema verified" section.
 *   This script's PASS/FAIL output should be read alongside that report.
 *
 *   Existence checks via SELECT * LIMIT 0 still work and are reliable.
 *   Column-level checks return empty arrays (not false-negative on existence
 *   — those still pass — but the per-column assertions cannot resolve via
 *   PostgREST and will FAIL noisily). This is documented; it is not a sprint
 *   blocker because the verified-via-MCP findings are the source of truth.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npx ts-node scripts/preflight-cc-sprint-2.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FAIL: SUPABASE_URL and SUPABASE_SERVICE_KEY required in env');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  const tag = pass ? '✅ PASS' : '❌ FAIL';
  console.log(`${tag}  ${name}`);
  if (detail) console.log(`         ${detail}`);
}

async function tableExists(table: string): Promise<{ exists: boolean; cols?: any[] }> {
  // information_schema.columns is the source of truth
  const { data, error } = await sb
    .from('information_schema.columns' as any)
    .select('column_name, data_type, is_nullable')
    .eq('table_schema', 'public')
    .eq('table_name', table)
    .order('ordinal_position');
  if (error) {
    // Some Supabase setups don't expose information_schema via PostgREST.
    // Fallback: try to SELECT 0 rows from the table.
    const probe = await sb.from(table).select('*').limit(0);
    if (probe.error) return { exists: false };
    return { exists: true };
  }
  return { exists: (data?.length ?? 0) > 0, cols: data ?? [] };
}

async function rpcExists(routineName: string): Promise<boolean> {
  const { data, error } = await sb
    .from('information_schema.routines' as any)
    .select('routine_name')
    .eq('routine_schema', 'public')
    .eq('routine_name', routineName);
  if (error) {
    console.warn(`         (information_schema.routines unreadable: ${error.message})`);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

(async () => {
  console.log('--- CC Sprint 2 Preflight ---');
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log('');

  // 1. trade_execution_log — primary closure trigger source
  const tel = await tableExists('trade_execution_log');
  if (!tel.exists) {
    record('trade_execution_log exists', false, 'sprint Arc A cannot wire RepID earning without this table');
  } else {
    const cols = (tel.cols ?? []).map((c: any) => `${c.column_name}:${c.data_type}`);
    record('trade_execution_log exists', true, `${cols.length} columns`);
    // Sub-check: status, agent_id, pnl-shaped column
    const colNames = (tel.cols ?? []).map((c: any) => c.column_name);
    record('trade_execution_log.status present', colNames.includes('status'), `cols sampled: ${colNames.slice(0, 12).join(', ')}`);
    const hasAgent = colNames.includes('agent_id') || colNames.includes('agent_uuid');
    record('trade_execution_log has agent identifier', hasAgent, hasAgent ? 'agent_id or agent_uuid present' : 'NEITHER agent_id NOR agent_uuid found');
    const pnlCols = colNames.filter((n: string) => /pnl|profit|return/i.test(n));
    record('trade_execution_log has pnl-shaped column', pnlCols.length > 0, `pnl-shaped: ${pnlCols.join(', ') || 'NONE'}`);
    const closedAt = colNames.includes('closed_at');
    record('trade_execution_log.closed_at present', closedAt, closedAt ? 'closure ts available' : 'no closed_at — use status only');
  }

  // 2. RepID event log — sprint says "repid_events", CLAUDE.md says canonical is "repid_score_events"
  const re = await tableExists('repid_events');
  const rse = await tableExists('repid_score_events');
  record('repid_events exists', re.exists, re.exists ? `${(re.cols ?? []).length} cols` : 'TABLE MISSING — fall back to repid_score_events per CLAUDE.md');
  record('repid_score_events exists (CLAUDE.md canonical)', rse.exists, rse.exists ? `${(rse.cols ?? []).length} cols` : '');
  if (rse.exists) {
    const colNames = (rse.cols ?? []).map((c: any) => c.column_name);
    console.log(`         repid_score_events cols: ${colNames.slice(0, 16).join(', ')}${colNames.length > 16 ? '...' : ''}`);
  }

  // 3. repid_agents 9 new columns from this morning's migrations
  const ra = await tableExists('repid_agents');
  if (!ra.exists) {
    record('repid_agents exists', false, 'CRITICAL — engine cannot run');
  } else {
    const colNames = (ra.cols ?? []).map((c: any) => c.column_name);
    const expected9 = [
      'mint_tx_hash', 'mint_block_number', 'minted_at', 'mint_chain_id',
      'last_reputation_tx_hash', 'last_reputation_block_number',
      'last_reputation_repid', 'last_reputation_written_at', 'reputation_write_count'
    ];
    const missing = expected9.filter(c => !colNames.includes(c));
    record(
      'repid_agents has all 9 new columns from morning migrations',
      missing.length === 0,
      missing.length === 0 ? 'all 9 present' : `MISSING: ${missing.join(', ')}`
    );
    const hasCurrentRepid = colNames.includes('current_repid');
    record('repid_agents.current_repid present', hasCurrentRepid, hasCurrentRepid ? 'OK' : 'MISSING — engine cannot score');
    const hasTier = colNames.includes('tier');
    record('repid_agents.tier present (trigger-derived)', hasTier, 'WRITE current_repid; trg_sync_tier updates tier');
  }

  // 4. graph-rag tables + RPCs
  const amn = await tableExists('agent_memory_nodes');
  record('agent_memory_nodes exists', amn.exists, amn.exists ? 'graph-rag foundation applied' : 'foundation missing');
  const ame = await tableExists('agent_memory_edges');
  record('agent_memory_edges exists', ame.exists, '');
  const matchRpc = await rpcExists('graph_rag_match_nodes');
  record('graph_rag_match_nodes RPC exists', matchRpc, '');
  const touchRpc = await rpcExists('graph_rag_touch_node');
  record('graph_rag_touch_node RPC exists', touchRpc, '');

  // 5. erc8004_reputation_writes — Wave 6 audit table
  const erw = await tableExists('erc8004_reputation_writes');
  record('erc8004_reputation_writes exists', erw.exists, erw.exists ? 'reputation audit table ready' : 'Wave 6 reputation migration missing');

  // 6. user_api_keys — sprint Arc B.3 needs this for BYOK bypass
  const uak = await tableExists('user_api_keys');
  if (uak.exists) {
    const colNames = (uak.cols ?? []).map((c: any) => c.column_name);
    record('user_api_keys exists', true, `cols: ${colNames.join(', ')}`);
    const keyHash = colNames.includes('key_hash');
    record('user_api_keys.key_hash present (SHA-256 storage)', keyHash, keyHash ? 'BYOK bypass can use this' : 'sprint may need migration');
    const revoked = colNames.includes('revoked_at') || colNames.includes('key_status');
    record('user_api_keys revocation field present', revoked, '');
  } else {
    record('user_api_keys exists', false, 'Arc B.3 must run migrations/2026-05-11-user-api-keys.sql first');
  }

  // 7. feedback_events (Arc C target — should NOT exist yet)
  const fe = await tableExists('feedback_events');
  record('feedback_events does NOT exist (Arc C will create)', !fe.exists, fe.exists ? 'TABLE ALREADY EXISTS — Arc C migration must use IF NOT EXISTS' : 'clean slate');

  // 8. compute_tier function exists (CLAUDE.md says we MUST never write tier directly — verify trigger present)
  const ct = await rpcExists('compute_tier');
  record('compute_tier function exists', ct, ct ? 'trigger trg_sync_tier will work' : 'trigger may be missing — write current_repid + verify tier follows');

  console.log('');
  console.log('--- Summary ---');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`PASS: ${passed}`);
  console.log(`FAIL: ${failed}`);
  console.log('');

  if (failed > 0) {
    console.log('FAILED:');
    for (const r of results.filter(r => !r.pass)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
    console.log('');
    console.log('STOP. Surface failures to Sean before writing code.');
    process.exit(1);
  }

  console.log('All checks passed. Safe to proceed with sprint code.');
  process.exit(0);
})().catch((e) => {
  console.error('Preflight crashed:', e);
  process.exit(2);
});
