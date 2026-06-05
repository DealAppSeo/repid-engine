import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  const { data, error } = await supabase.rpc('run_sql', {
    sql: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'repid_agents'`
  });
  if (error) {
    console.error('RPC failed:', error);
  } else {
    console.log('Columns of repid_agents:', data);
  }
}

main().catch(console.error);
