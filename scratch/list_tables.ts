import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const { data, error } = await supabase.rpc('run_sql', {
    sql: `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('trinity_tasks', 'task_escalations', 'hallucination_fingerprints', 'agent_mentorships', 'agent_learning_events', 'repid_agents')`
  });
  if (error) {
    console.error('RPC run_sql failed:', error);
  } else {
    console.log('Tables found:', data);
  }
}

main().catch(console.error);
