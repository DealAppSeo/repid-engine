const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const supabase = createClient('https://qnnpjhlxljtqyigedwkb.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFubnBqaGx4bGp0cXlpZ2Vkd2tiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MTkzOTU5MSwiZXhwIjoyMDY3NTE1NTkxfQ.4ADAiDK-CD6Jk5_JgizadriWVBoYg42NnsKsbcQ0h6A');

async function run() {
  const aliceId = 'd52f54a1-3656-4f80-bbb4-0abb231efdff';
  const charlieId = crypto.randomUUID();
  const danaId = crypto.randomUUID();

  // 1. Add humans
  await supabase.from('repid_mvp_users').insert([
    { id: charlieId, user_address: '0xCharlie', display_name: 'Charlie' },
    { id: danaId, user_address: '0xDana', display_name: 'Dana' }
  ]);

  // 2. Clear Alice's old stakes to keep exactly one active
  await supabase.from('repid_mvp_stakes')
    .update({ status: 'withdrawn', withdrawn_at: new Date().toISOString() })
    .eq('user_id', aliceId);

  // Agents
  const agents = {
    veritas: '6b48848d-d080-4851-95f5-315179358603',
    testNewbie: 'c6fb2137-83c1-4b7b-a64b-2a22b0e3795a',
    sophia: 'e19637aa-39c6-4b30-8eb8-804ecb9399c8'
  };

  // 3. Insert active stakes
  await supabase.from('repid_mvp_stakes').insert([
    { user_id: aliceId, agent_id: agents.veritas, stake_amount_usd: 750, status: 'active' },
    { user_id: charlieId, agent_id: agents.testNewbie, stake_amount_usd: 200, status: 'active' },
    { user_id: danaId, agent_id: agents.sophia, stake_amount_usd: 2000, status: 'active' }
  ]);

  // 4. Enable RLS on repid_mvp_trade_attempts & Add policy (Can use SQL query via REST, or a Postgres function if available, but usually we can't execute raw SQL via JS client without an rpc).
  // I will check if there is an rpc to run sql.
  const { data, error } = await supabase.rpc('exec_sql', { sql: `
    ALTER TABLE repid_mvp_trade_attempts ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "Public Read on Trade Attempts" ON repid_mvp_trade_attempts;
    CREATE POLICY "Public Read on Trade Attempts" ON repid_mvp_trade_attempts FOR SELECT USING (true);
  `});
  console.log('RPC exec_sql:', error || 'success');

  // If no RPC, I can run it from `repid-engine` which might have Postgres connection or I'll run `psql`.
}
run();
