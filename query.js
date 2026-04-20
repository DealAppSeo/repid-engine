const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const query = "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name IN ('hal_veto_test_results', 'hal_antifragility_metrics', 'hal_anfis_snapshots', 'hal_ablation_results', 'hallucination_test_log') ORDER BY table_name, ordinal_position";
fetch(process.env.SUPABASE_URL + '/rest/v1/rpc/exec_sql', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY, 'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY },
  body: JSON.stringify({ query })
}).then(r=>r.json()).then(d=>require('fs').writeFileSync('schema.json', JSON.stringify(d, null, 2)));
