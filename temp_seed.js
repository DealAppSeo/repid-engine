const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('https://qnnpjhlxljtqyigedwkb.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFubnBqaGx4bGp0cXlpZ2Vkd2tiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MTkzOTU5MSwiZXhwIjoyMDY3NTE1NTkxfQ.4ADAiDK-CD6Jk5_JgizadriWVBoYg42NnsKsbcQ0h6A');

async function run() {
  const { data: users, error: errU } = await supabase.from('repid_mvp_users').select('*');
  const { data: agents, error: errA } = await supabase.from('repid_mvp_agents').select('*');
  const { data: stakes, error: errS } = await supabase.from('repid_mvp_stakes').select('*');
  const { data: trades, error: errT } = await supabase.from('repid_mvp_trade_attempts').select('*');

  console.log('Users:', users || errU);
  console.log('Agents:', agents || errA);
  console.log('Stakes:', stakes || errS);
  console.log('Trades:', trades || errT);
}
run();
