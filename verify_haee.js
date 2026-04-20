const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log("=== DB CHECK: hal_antifragility_metrics ===");
  const { data } = await supabase.from('hal_antifragility_metrics').select('id, created_at, domain_metrics, is_antifragile').order('created_at', { ascending: false }).limit(3);
  console.log(JSON.stringify(data, null, 2));

  console.log("\n=== HEALTH CHECK ===");
  const { data: health } = await supabase.rpc('daily_system_health_check');
  console.log(JSON.stringify(health, null, 2));

  console.log("\n=== FRONT-END CHECK ===");
  try {
    const r = await fetch('https://www.trustrepid.dev/hal');
    const text = await r.text();
    console.log("Page loads:", r.status === 200);
    console.log("Contains 'HAL Accuracy':", text.includes('HAL Accuracy'));
    console.log("\nFirst 200 chars:\n" + text.substring(0, 200));
  } catch(e) {
    console.error("Fetch failed:", e);
  }
}

run();
