import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

async function run() {
  const wId = '88679e70-1fad-430e-a215-3cd6439ba7cf';
  const mId = '44cebb64-f4f2-46d1-8782-d83c5bf23202';
  
  // W deposit
  await db.rpc('run_sql', { sql: `INSERT INTO stake_deposits (builder_id, amount, status, is_simulated, deposit_tx_hash) VALUES ('${wId}', 1000000000, 'active', true, 'simulated:W')`});
  // M deposit
  await db.rpc('run_sql', { sql: `INSERT INTO stake_deposits (builder_id, amount, status, is_simulated, deposit_tx_hash) VALUES ('${mId}', 50000000, 'active', true, 'simulated:M')`});
  
  console.log("Forced deposits done.");
}
run();
