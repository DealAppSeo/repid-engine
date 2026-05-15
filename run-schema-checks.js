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
}

run();
