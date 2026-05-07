const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function backfill() {
  console.log('Starting backfill of repid_proof_queue...');
  
  const { data, error } = await supabase
    .from('repid_proof_queue')
    .update({ 
      zkp_service_url: 'https://zkp-postcard-production.up.railway.app'
    })
    .eq('zkp_service_url', 'http://localhost:8080')
    .eq('status', 'pending');

  if (error) {
    console.error('Error during backfill:', error);
    process.exit(1);
  }

  console.log(`Successfully updated rows in repid_proof_queue.`);
}

backfill();
