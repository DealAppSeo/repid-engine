require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data, error } = await supabase
    .from('repid_score_events')
    .select('metadata')
    .eq('id', 317)
    .single();
  
  if (error) console.error("Error:", error);
  else console.log("Metadata:", JSON.stringify(data.metadata, null, 2));
}

run();
