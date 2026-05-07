const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function checkStats() {
  const { data: completed } = await supabase
    .from('repid_proof_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'completed');

  const { data: failed } = await supabase
    .from('repid_proof_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'failed');

  const { data: pending } = await supabase
    .from('repid_proof_queue')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');

  console.log('Final Stats:');
  console.log('  Completed:', completed?.length ?? 0);
  console.log('  Failed:   ', failed?.length ?? 0);
  console.log('  Pending:  ', pending?.length ?? 0);
}

checkStats();
