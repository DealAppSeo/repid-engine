const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function run() {
  const mode = process.argv[2];
  if (mode === 'log') {
    const { data } = await supabase.from('llm_call_log').select('*').order('created_at', { ascending: false }).limit(1);
    console.log(JSON.stringify(data[0], null, 2));
  } else if (mode === 'cap') {
    const { data } = await supabase.from('llm_provider_caps').select('provider, current_month_spent_usd, hard_disabled, monthly_limit_usd').eq('provider', 'groq').single();
    console.log(JSON.stringify(data, null, 2));
  } else if (mode === 'set-cap') {
    await supabase.from('llm_provider_caps').update({ monthly_limit_usd: 0.01, current_month_spent_usd: 0.02 }).eq('provider', 'groq');
    console.log('Set groq cap to 0.01 and spent to 0.02');
  } else if (mode === 'reset-cap') {
    await supabase.from('llm_provider_caps').update({ monthly_limit_usd: 0, hard_disabled: false, current_month_spent_usd: 0 }).eq('provider', 'groq');
    console.log('Reset groq cap and spent to 0');
  }
}

run().catch(console.error);
