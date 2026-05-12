/**
 * Preflight schema check for CC Sprint 6 (recovery substrate + patent evidence).
 *
 * Verifies every table/view/column/UUID this sprint will touch BEFORE we
 * write code, per established Sprint 2/3/4/5 discipline.
 *
 * NOTE on PostgREST limitation (carried from prior sprints):
 *   Supabase PostgREST does NOT expose information_schema as a queryable
 *   relation. Per-column existence checks here will FAIL noisily; treat
 *   that as cosmetic. Authoritative verification was performed via
 *   Supabase MCP and is documented in the sprint report.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npx ts-node scripts/preflight-cc-sprint-6.ts
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

const SPOKESPERSON_UUIDS = {
  SOPHIA: 'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271',
  VERITAS: 'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067',
  SHOFET: '32e0e809-c1c4-4405-913f-135c8a2d6626',
  CHESED: '2c2c24d6-2fd0-47e6-95d5-7fc9804a19e6',
};

const TABLES = [
  'trinity_heartbeat', 'trinity_tasks', 'trinity_artifacts', 'agent_squad_map',
  'repid_agents', 'repid_score_events', 'hal_runner_results', 'hal_evaluations',
  'repid_proof_queue',
];

(async () => {
  console.log('--- CC Sprint 6 Preflight ---');
  console.log(`Supabase: ${SUPABASE_URL}\n`);

  // 1. Tables exist (probe with limit-0 SELECT — works under PostgREST)
  for (const t of TABLES) {
    const probe = await sb.from(t).select('*').limit(0);
    record(`${t} exists`, !probe.error, probe.error?.message ?? 'reachable');
  }

  // 2. View exists (Sprint 4 deliverable should still be queryable)
  const viewProbe = await sb.from('hal_accuracy_summary').select('*').limit(1);
  record('hal_accuracy_summary view queryable', !viewProbe.error,
    viewProbe.error?.message ?? `returned ${viewProbe.data?.length ?? 0} row(s)`);

  // 3. Spokesperson UUIDs resolve
  for (const [name, uuid] of Object.entries(SPOKESPERSON_UUIDS)) {
    const r = await sb.from('repid_agents').select('id, agent_name, current_repid, tier').eq('id', uuid).maybeSingle();
    if (r.error || !r.data) {
      record(`spokesperson ${name} (${uuid})`, false, r.error?.message ?? 'no row');
    } else {
      const matches = r.data.agent_name === name;
      record(`spokesperson ${name} (${uuid}) resolves`, matches,
        `${r.data.agent_name} repid=${r.data.current_repid} tier=${r.data.tier}`);
    }
  }

  // 4. trinity_heartbeat schema sanity (Sprint 5 finding: column is 'agent' not 'agent_name')
  const hbProbe = await sb.from('trinity_heartbeat').select('agent, last_seen, status, version').limit(1);
  record('trinity_heartbeat has agent + last_seen columns', !hbProbe.error,
    hbProbe.error?.message ?? 'schema confirmed');

  // 5. agent_squad_map population (12 trinity agents expected)
  const asmProbe = await sb.from('agent_squad_map').select('agent_name, squad', { count: 'exact' });
  const count = asmProbe.count ?? 0;
  record('agent_squad_map has 12 trinity agents', count >= 12,
    `${count} rows`);

  console.log('\n--- Summary ---');
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log(`PASS: ${passed}\nFAIL: ${failed}\n`);
  if (failed > 0) {
    console.log('FAILED:');
    for (const r of results.filter(r => !r.pass)) console.log(`  - ${r.name}: ${r.detail}`);
    console.log('\nSTOP. Surface failures to Sean before proceeding.');
    process.exit(1);
  }
  console.log('Preflight green. Proceed with sprint phases.');
  process.exit(0);
})().catch((e) => { console.error('Preflight crash:', e); process.exit(2); });
