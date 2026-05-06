import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
async function check() {
    const { data, error } = await supabase.from('repid_agents').select('id, agent_id, display_name, repid_score').eq('agent_id', 'sophia');
    console.log("SOPHIA:", error || data);
}
check();
