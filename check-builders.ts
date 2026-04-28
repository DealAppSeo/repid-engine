import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

async function run() {
  const { data, error } = await db.from('builders').select('*');
  console.log(JSON.stringify({ data, error }, null, 2));
}
run();
