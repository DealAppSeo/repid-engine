const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function findTokenAgents() {
  const { data, error } = await supabase
    .from('repid_agents')
    .select('id, agent_name, erc8004_token_id')
    .not('erc8004_token_id', 'is', null)
    .limit(10);

  if (error) {
    console.error('Error:', error);
    process.exit(1);
  }

  console.log('Agents with token IDs:', data);
}

findTokenAgents();
