import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function check() {
    const { data, error } = await supabase.rpc('exec_sql', {
        query: `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_name IN ('repid_stakes', 'repid_agents', 'repid_trade_attempts', 'repid_users') ORDER BY table_name`
    });
    console.log(error || data);
}
check();
