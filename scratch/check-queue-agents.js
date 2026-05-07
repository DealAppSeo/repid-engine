const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function checkAgents() {
  const { data, error } = await supabase
    .from('repid_proof_queue')
    .select('agent_id')
    .limit(10);

  if (error) {
    console.error('Error:', error);
    process.exit(1);
  }

  console.log('Agent IDs in queue:', data.map(d => d.agent_id));
}

checkAgents();
