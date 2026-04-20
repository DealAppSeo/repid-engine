const sql = "INSERT INTO public.repid_config (key, value, description) VALUES ('zkp_service_url', 'https://zkp-postcard-production.up.railway.app', 'Plonky3 STARK proof service on Railway') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;";
const apikey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFubnBqaGx4bGp0cXlpZ2Vkd2tiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTE5Mzk1OTEsImV4cCI6MjA2NzUxNTU5MX0.6oG2DU_BD1uBnBrDoQFauvN1ZnkKo2ywkuwY-tPaQFw';
fetch('https://qnnpjhlxljtqyigedwkb.supabase.co/rest/v1/rpc/exec_sql', {
  method: 'POST',
  headers: {
    'apikey': apikey,
    'Authorization': 'Bearer ' + apikey,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ query: sql })
}).then(async r => {
  console.log('STATUS:', r.status);
  console.log('RESPONSE:', await r.text());
});
