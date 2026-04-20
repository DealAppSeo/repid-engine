require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  console.log("=== TRACK 1: TELEGRAM ===");
  try {
    const { data } = await supabase.from('repid_agents').select('agent_name,current_repid,tier,vdr_count').order('current_repid', { ascending: false }).limit(6);
    const vdrObj = await supabase.from('repid_agents').select('vdr_count');
    const vdr = vdrObj.data?.reduce((s,a)=>s+(a.vdr_count||0),0) || 0;
    const reply = '\uD83E\uDD16 <b>TRINITY SYMPHONY</b>\n'
      + 'VDR: ' + vdr + ' | Decisions: 264\n\n'
      + (data||[]).map(a=>
        (a.tier==='AUTONOMOUS'?'\uD83D\uDD35':a.tier==='EARNING_AUTONOMY'?'\uD83D\uDFE1':'\u26AA') + ' '
        + a.agent_name + ': ' + a.current_repid + ' RepID'
      ).join('\n');
    console.log('Bot Reply: \n' + reply);
  } catch(e) { console.error(e); }

  console.log("\n=== TRACK 3 & TRACK 4 ===");
  try {
    const r = await supabase.from('repid_proof_queue').select('status');
    const sq = (r.data||[]).reduce((a,c)=>{ a[c.status]=(a[c.status]||0)+1; return a; }, {});
    console.log("Queue:", sq);

    const ds = await supabase.from('repid_score_events').select('id', { count: 'exact' });
    console.log("Decisions Count:", ds.count);
  } catch (e) { console.error(e); }

  console.log("\n=== TRACK 6: METRICS ===");
  try {
    const res = await fetch('https://repid-engine-production.up.railway.app/api/v1/metrics');
    const json = await res.json();
    console.log('Metrics endpoint:', json);
  } catch (e) { console.error(e.message); }

  console.log("\n=== HEALTH CHECK ===");
  try {
    const { data } = await supabase.rpc('daily_system_health_check');
    console.log(data);
  } catch(e) { console.error(e); }
}

run();
