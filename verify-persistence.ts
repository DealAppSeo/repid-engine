import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);
  const { data, error } = await db
    .from('repid_agents')
    .select('agent_name, canonical_agent_id, canonical_registry')
    .in('agent_name', ['APM', 'VERITAS']);
    
  if (error) {
    console.error('Error fetching:', error);
  } else {
    console.log(data);
  }
}

run().catch(console.error);
