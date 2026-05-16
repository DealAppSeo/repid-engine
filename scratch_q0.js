const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function check() {
  console.log("=== Q0.1: Latest VALIDATION events ===");
  const { data: events, error: e1 } = await db.from('repid_score_events')
    .select('event_type, delta, metadata, created_at')
    .in('event_type', ['VALIDATION_PASSED', 'VALIDATION_FAILED', 'VALIDATOR_REWARD', 'VALIDATOR_PENALTY'])
    .order('created_at', { ascending: false })
    .limit(10);
  console.log(e1 ? e1 : events);

  console.log("\n=== Q0.2: trinity_tasks.tier distribution ===");
  const { data: tiers, error: e2 } = await db.rpc('run_sql', { query: `
    SELECT tier, COUNT(*) AS count
    FROM trinity_tasks GROUP BY tier ORDER BY count DESC LIMIT 10;
  `});
  if (e2 && e2.code === 'PGRST202') {
    // try direct group by using JS since rpc is missing
    const { data: allTasks } = await db.from('trinity_tasks').select('tier');
    const counts = {};
    for (const t of allTasks || []) {
      counts[t.tier] = (counts[t.tier] || 0) + 1;
    }
    console.log(counts);
  } else {
    console.log(e2 ? e2 : tiers);
  }
}
check();
