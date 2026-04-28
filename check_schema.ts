import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

async function run() {
  const res = await db.rpc('run_sql', { sql: "SELECT column_name FROM information_schema.columns WHERE table_name='stake_deposits';" });
  console.log(JSON.stringify(res, null, 2));
}
run();
