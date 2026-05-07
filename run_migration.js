const fs = require('fs');
const dotenv = require('dotenv');
dotenv.config();

const apikey = process.env.SUPABASE_SERVICE_KEY;
const sql = fs.readFileSync('./supabase/migrations/2026-05-07-llm-caps-rpc.sql', 'utf-8');

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
  console.log("Status:", r.status);
  console.log("Response:", await r.text());
})
.catch(console.error);
