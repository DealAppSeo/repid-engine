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
  console.log('--- PRE-FLIGHT SCHEMA CHECK ---');

  // 1. Check agent_repid columns
  const { data: q1, error: e1 } = await supabase.rpc('run_sql', { sql: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'agent_repid' ORDER BY ordinal_position LIMIT 3" });
  console.log('1. agent_repid PK:', e1 ? e1.message : q1);

  // 2. Check trinity_tasks status enum
  const { data: q2, error: e2 } = await supabase.rpc('run_sql', { sql: "SELECT data_type FROM information_schema.columns WHERE table_name = 'trinity_tasks' AND column_name = 'status'" });
  console.log('2. trinity_tasks status type:', e2 ? e2.message : q2);
  // 3. Query repid_agents
  const { data: q3, error: e3 } = await supabase.rpc('run_sql', { sql: "SELECT agent_name FROM repid_agents WHERE agent_name LIKE 'trinity-%' ORDER BY agent_name" });
  console.log('3. repid_agents:', e3 ? e3.message : q3);
  // 4. Query constraints
  const { data: q4, error: e4 } = await supabase.rpc('run_sql', { sql: "SELECT pg_get_constraintdef(c.oid) AS check_constraint FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid WHERE t.relname = 'trinity_tasks' AND c.contype = 'c' AND pg_get_constraintdef(c.oid) ILIKE '%status%'" });
  console.log('4. constraints:', e4 ? e4.message : q4);

  // 5. Query columns of repid_score_events
  const { data: q5, error: e5 } = await supabase.rpc('run_sql', { sql: "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'repid_score_events' AND column_name IN ('agent_id', 'repid_before', 'repid_after', 'event_type', 'delta') ORDER BY column_name" });
  console.log('5. columns:', e5 ? e5.message : q5);
}

run();
