import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = createClient(supabaseUrl, supabaseKey);

async function main() {
  console.log('Checking existing tables...');
  // Since supabase-js doesn't expose a direct sql query without an RPC, 
  // we can check if the tables exist by trying to select from them
  let logResult = await supabase.from('llm_call_log').select('id').limit(1);
  let capResult = await supabase.from('llm_provider_caps').select('id').limit(1);

  if (logResult.error?.code !== '42P01' && !logResult.error) {
    console.log('llm_call_log EXISTS');
  } else if (logResult.error?.code === '42P01') {
    console.log('llm_call_log does NOT exist');
  } else {
    console.log('llm_call_log error:', logResult.error);
  }

  if (capResult.error?.code !== '42P01' && !capResult.error) {
    console.log('llm_provider_caps EXISTS');
  } else if (capResult.error?.code === '42P01') {
    console.log('llm_provider_caps does NOT exist');
  } else {
    console.log('llm_provider_caps error:', capResult.error);
  }

  console.log('Testing write access to repid_mvp_users...');
  const insertRes = await supabase.from('repid_mvp_users').insert({ display_name: 'a3_smoke_test' }).select('id');
  if (insertRes.error) {
    console.error('INSERT FAILED:', insertRes.error);
  } else {
    console.log('INSERT SUCCEEDED:', insertRes.data);
    const deleteRes = await supabase.from('repid_mvp_users').delete().eq('display_name', 'a3_smoke_test');
    if (deleteRes.error) {
      console.error('DELETE FAILED:', deleteRes.error);
    } else {
      console.log('DELETE SUCCEEDED');
    }
  }
}

main().catch(console.error);
