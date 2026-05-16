const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function check() {
  const { data, error } = await db.from('repid_agents').select('*').limit(10);
  console.log(error || data);
}
check();
