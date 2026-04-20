const apikey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFubnBqaGx4bGp0cXlpZ2Vkd2tiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5Mzk1OTEsImV4cCI6MjA2NzUxNTU5MX0.6oG2DU_BD1uBnBrDoQFauvN1ZnkKo2ywkuwY-tPaQFw';
const SUPA_URL = 'https://qnnpjhlxljtqyigedwkb.supabase.co';

async function run() {
  const r1 = await fetch(`${SUPA_URL}/rest/v1/repid_agents?select=agent_name,current_repid,vdr_count&vdr_count=gt.0&order=current_repid.desc&limit=15`, {
      headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey }
  });
  console.log("Track 6 Proof:", await r1.json());

  const r2 = await fetch(`${SUPA_URL}/rest/v1/hal_training_cases?select=id`, {
      headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey, 'Prefer': 'count=exact' }
  });
  console.log("Track 8 Proof: hal_training_cases count:", r2.headers.get('content-range'));
}
run();
