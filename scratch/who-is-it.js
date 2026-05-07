const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function whoIsIt() {
  const { data, error } = await supabase
    .from('repid_agents')
    .select('agent_name')
    .eq('id', 'aa17d58e-8194-478b-9151-f6dc9fd8cdbe')
    .single();

  if (error) {
    console.error('Error:', error);
    process.exit(1);
  }

  console.log('Agent Name:', data.agent_name);
}

whoIsIt();
