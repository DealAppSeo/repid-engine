const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function check() {
  const { data, error } = await db.from('trinity_tasks').select('status').not('claimed_by', 'is', null).limit(10);
  if (error) console.error(error);
  else console.log(data);
}
check();
