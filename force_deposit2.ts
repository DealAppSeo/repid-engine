import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

async function run() {
  const wId = '88679e70-1fad-430e-a215-3cd6439ba7cf';
  const mId = '44cebb64-f4f2-46d1-8782-d83c5bf23202';
  
  const r1 = await db.from('stake_deposits').insert({ builder_id: wId, amount: 1000000000, status: 'active', is_simulated: true });
  console.log("W:", r1.error || "ok");
  
  const r2 = await db.from('stake_deposits').insert({ builder_id: mId, amount: 50000000, status: 'active', is_simulated: true });
  console.log("M:", r2.error || "ok");
}
run();
