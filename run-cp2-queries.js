require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials in .env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function run() {
  console.log('--- CP2 QUERIES ---');

  // 1. All 12 agents healthy
  const { data: q1, error: e1 } = await supabase.rpc('run_sql', { sql: "SELECT COUNT(*) as cnt FROM agent_heartbeat WHERE agent_name LIKE 'trinity-%' AND agent_name NOT LIKE '%-local' AND EXTRACT(EPOCH FROM (NOW() - last_ping)) < 600" });
  console.log('1. Agents healthy (last 10m):', e1 ? e1.message : q1);

  // 2. Substance gate fired on multiple agents
  const { data: q2, error: e2 } = await supabase.rpc('run_sql', { sql: "SELECT COUNT(DISTINCT agent_name) AS distinct_agents FROM trinity_agent_logs WHERE action = 'substance_gate_shadow_reject' AND created_at > '2026-05-14'" });
  console.log('2. Substance gate distinct agents:', e2 ? e2.message : q2);

  // 3. No untagged tasks
  const { data: q3, error: e3 } = await supabase.rpc('run_sql', { sql: "SELECT COUNT(*) AS untagged FROM trinity_tasks WHERE created_at > '2026-05-15 00:00:00' AND metadata->>'test_tier' IS NULL" });
  console.log('3. Untagged tasks since 2026-05-15:', e3 ? e3.message : q3);

  // 4. llm_call_log and repid_score_events writes
  const { data: q4, error: e4 } = await supabase.rpc('run_sql', { sql: "SELECT 'llm_call_log_1h' AS metric, COUNT(*) AS cnt FROM llm_call_log WHERE created_at > NOW() - INTERVAL '1 hour' UNION ALL SELECT 'repid_score_events_1h', COUNT(*) FROM repid_score_events WHERE created_at > NOW() - INTERVAL '1 hour'" });
  console.log('4. Recent writes:', e4 ? e4.message : q4);
}

run();
