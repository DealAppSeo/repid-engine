const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function check() {
  const { data, error } = await db.from('repid_score_events')
    .select('id, agent_id, metadata, created_at')
    .order('created_at', { ascending: false })
    .limit(5);
  console.log(JSON.stringify(data, null, 2));
}
check();
