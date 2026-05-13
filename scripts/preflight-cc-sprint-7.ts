/**
 * Preflight schema check for CC Sprint 7 (gap closure + distribution).
 *
 * Verifies prior-sprint deliverables are still in place AND the surface
 * Sprint 7 will touch is in the expected state.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npx ts-node scripts/preflight-cc-sprint-7.ts
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
  console.log('--- CC Sprint 7 Preflight ---');
  console.log(`Supabase: ${SUPABASE_URL}\n`);

  // Sprint 6 deliverables
  const swarmHealth = await sb.from('trinity_swarm_health').select('agent_name', { count: 'exact', head: true });
  record('Sprint 6 trinity_swarm_health view returns 12 rows',
    (swarmHealth.count ?? 0) === 12,
    swarmHealth.error?.message ?? `${swarmHealth.count} rows`);

  const hbProbe = await sb.from('trinity_heartbeat')
    .select('agent, last_seen, heartbeat_interval_ms').limit(1);
  record('Sprint 6 trinity_heartbeat.heartbeat_interval_ms column exists', !hbProbe.error,
    hbProbe.error?.message ?? 'column reachable');

  // Sprint 7 will create — should NOT exist yet
  const gtProbe = await sb.from('hal_ground_truth_labels').select('id').limit(0);
  record('hal_ground_truth_labels does NOT exist yet (Sprint 7 will create)',
    !!gtProbe.error,
    gtProbe.error?.message ?? 'table already exists — review for collision');

  // Schema canonicalization references
  const re = await sb.from('repid_events').select('id', { count: 'exact', head: true });
  record('repid_events queryable for schema canonicalization analysis', !re.error,
    re.error?.message ?? `${re.count} rows`);

  const rse = await sb.from('repid_score_events').select('id', { count: 'exact', head: true });
  record('repid_score_events queryable', !rse.error,
    rse.error?.message ?? `${rse.count} rows`);

  // agent_squad_map for Decision B analysis
  const asm = await sb.from('agent_squad_map').select('agent_name, squad', { count: 'exact' });
  record('agent_squad_map populated', (asm.count ?? 0) >= 12,
    `${asm.count} rows`);

  // 4 spokesperson UUIDs still resolve (Sprint 6 carry-forward)
  const spokesperson = await sb.from('repid_agents')
    .select('id, agent_name')
    .in('id', [
      'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271',
      'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067',
      '32e0e809-c1c4-4405-913f-135c8a2d6626',
      '2c2c24d6-2fd0-47e6-95d5-7fc9804a19e6',
    ]);
  record('4 spokesperson UUIDs resolve', (spokesperson.data?.length ?? 0) === 4,
    `${spokesperson.data?.length ?? 0}/4 found`);

  // hal_runner_results — truth-related cols audit
  const hrr = await sb.from('hal_runner_results')
    .select('id, hal_vetoed, ground_truth_is_hallucination, was_caught, false_positive')
    .limit(1);
  record('hal_runner_results has hal_vetoed + ground_truth_is_hallucination + was_caught + false_positive',
    !hrr.error, hrr.error?.message ?? 'columns reachable (Sprint 4 saw all gt=false)');

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
