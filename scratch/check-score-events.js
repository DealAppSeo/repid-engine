const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function checkScoreEvents() {
  const { data, error } = await supabase
    .from('repid_score_events')
    .select('*')
    .limit(1);

  if (error) {
    console.error('Error:', error);
    process.exit(1);
  }

  console.log('Columns:', Object.keys(data[0] || {}));
}

checkScoreEvents();
