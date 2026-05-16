const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env' });

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function run() {
  const { data, error } = await db.rpc('run_sql', { query: `
    SELECT pg_get_constraintdef(c.oid) AS def
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE c.conname = 'claim_atomic';
  `});
  if (error) console.error(error);
  else console.log(data);
}
run();
