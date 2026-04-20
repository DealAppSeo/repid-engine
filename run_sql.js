const apikey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFubnBqaGx4bGp0cXlpZ2Vkd2tiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5Mzk1OTEsImV4cCI6MjA2NzUxNTU5MX0.6oG2DU_BD1uBnBrDoQFauvN1ZnkKo2ywkuwY-tPaQFw';
async function run() {
  const r = await fetch('https://qnnpjhlxljtqyigedwkb.supabase.co/rest/v1/repid_agents?select=id,agent_name,constitution', {
    headers: { 'apikey': apikey, 'Authorization': 'Bearer ' + apikey }
  });
  console.log(await r.json());
}
run();
const apikey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFubnBqaGx4bGp0cXlpZ2Vkd2tiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5Mzk1OTEsImV4cCI6MjA2NzUxNTU5MX0.6oG2DU_BD1uBnBrDoQFauvN1ZnkKo2ywkuwY-tPaQFw';

fetch('https://qnnpjhlxljtqyigedwkb.supabase.co/rest/v1/rpc/exec_sql', {
  method: 'POST',
  headers: {
    'apikey': apikey,
    'Authorization': 'Bearer ' + apikey,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ query: sql })
})
.then(async r => {
  console.log(r.status);
  console.log(await r.text());
})
.catch(console.error);
