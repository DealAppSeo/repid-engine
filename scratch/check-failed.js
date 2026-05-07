const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function checkFailed() {
  const { count, error } = await supabase
    .from('repid_proof_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'failed');

  if (error) {
    console.error('Error:', error);
    process.exit(1);
  }

  console.log('Failed jobs count:', count);
}

checkFailed();
