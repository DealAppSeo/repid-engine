/**
 * Preflight for CC Sprint 3 (pnl_realized data path repair).
 *
 * Verifies the trade_execution_log state hasn't shifted since Sprint 2's
 * inventory and counts the population of fields needed for backfill /
 * reconstruction.
 *
 * NOTE on PostgREST limitation:
 *   Same as Sprint 2's preflight — Supabase PostgREST does NOT expose
 *   information_schema as a queryable relation. Per-column existence checks
 *   here will FAIL noisily; treat that as cosmetic. The authoritative
 *   verification is performed via Supabase MCP and documented in the sprint
 *   report's Phase 0 section (E:\dev\reports\2026-05-11\CC_SPRINT_3_REPORT.md).
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npx ts-node scripts/preflight-cc-sprint-3.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('FAIL: SUPABASE_URL and SUPABASE_SERVICE_KEY required');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

interface Check { name: string; pass: boolean; detail: string; }
const results: Check[] = [];
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${name}`);
  if (detail) console.log(`         ${detail}`);
}

(async () => {
  console.log('--- CC Sprint 3 Preflight ---');
  console.log(`Supabase: ${SUPABASE_URL}\n`);

  // 1. trade_execution_log existence
  const probe = await sb.from('trade_execution_log').select('*').limit(0);
  record('trade_execution_log exists', !probe.error,
    probe.error ? probe.error.message : 'reachable');

  // 2. Total row count
  const { count: total } = await sb
    .from('trade_execution_log')
    .select('*', { count: 'exact', head: true });
  record('trade_execution_log has rows', (total ?? 0) > 0, `${total} total`);

  // 3. pnl_realized population — this is THE finding
  const { count: withPnl } = await sb
    .from('trade_execution_log')
    .select('*', { count: 'exact', head: true })
    .not('pnl_realized', 'is', null);
  record('rows with pnl_realized', (withPnl ?? 0) > 0,
    `${withPnl} of ${total} (${total ? Math.round(100 * (withPnl ?? 0) / total) : 0}%)`);

  // 4. executed_price population — possible reconstruction signal
  const { count: withExecPrice } = await sb
    .from('trade_execution_log')
    .select('*', { count: 'exact', head: true })
    .not('executed_price', 'is', null);
  record('rows with executed_price', true,
    `${withExecPrice} of ${total} — reconstruction signal availability`);

  // 5. requested_price population — proposal price
  const { count: withReqPrice } = await sb
    .from('trade_execution_log')
    .select('*', { count: 'exact', head: true })
    .not('requested_price', 'is', null);
  record('rows with requested_price', true,
    `${withReqPrice} of ${total}`);

  // 6. EXECUTED-decision rows (real trade attempts, not refusals)
  const { count: executedRows } = await sb
    .from('trade_execution_log')
    .select('*', { count: 'exact', head: true })
    .in('decision', ['EXECUTED', 'EXECUTE']);
  record('rows with decision=EXECUTED/EXECUTE', true,
    `${executedRows} of ${total} — actual executions; the rest are REFUSED proposals`);

  // 7. EXECUTED + executed_price (the slice that COULD have pnl)
  const { count: execWithPrice } = await sb
    .from('trade_execution_log')
    .select('*', { count: 'exact', head: true })
    .in('decision', ['EXECUTED', 'EXECUTE'])
    .not('executed_price', 'is', null);
  record('EXECUTED rows with executed_price', true,
    `${execWithPrice} — these are the only rows with even partial fill data`);

  // 8. Most recent trade timestamp — is the writer still running?
  const { data: recent } = await sb
    .from('trade_execution_log')
    .select('id, executed_at, broker, decision')
    .order('id', { ascending: false })
    .limit(1);
  if (recent && recent[0]) {
    const r: any = recent[0];
    const ageDays = Math.floor((Date.now() - new Date(r.executed_at).getTime()) / 86400000);
    record('writer still active recently', ageDays < 7,
      `latest id=${r.id} executed_at=${r.executed_at} age=${ageDays}d broker=${r.broker} decision=${r.decision}`);
  } else {
    record('writer still active recently', false, 'no rows returned');
  }

  console.log(`\n--- Summary ---`);
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`PASS: ${passed}\nFAIL: ${failed}\n`);
  if (failed > 0) {
    console.log('FAILED:');
    for (const r of results.filter(r => !r.pass)) console.log(`  - ${r.name}: ${r.detail}`);
    console.log('\nSTOP. Surface failures to Sean before proceeding.');
    process.exit(1);
  }
  console.log('Preflight green. Proceed with discovery.');
  process.exit(0);
})().catch((e) => { console.error('Preflight crash:', e); process.exit(2); });
