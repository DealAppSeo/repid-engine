import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function run() {
    const base = { erc8004_address: '0x0', system_prompt: 'dummy', initial_score: 1000 };
    const agents = [
        { ...base, agent_id: 'sophia', display_name: 'SOPHIA', repid_score: 10000, autonomous_cap: 100000 },
        { ...base, agent_id: 'veritas', display_name: 'VERITAS', repid_score: 8500, autonomous_cap: 50000 },
        { ...base, agent_id: 'hdm', display_name: 'HDM', repid_score: 7200, autonomous_cap: 25000 },
        { ...base, agent_id: 'test-newbie', display_name: 'Test Newbie', repid_score: 100, autonomous_cap: 5000 }
    ];
    
    const { data, error } = await supabase.from('repid_agents').upsert(agents, { onConflict: 'agent_id' });
    console.log("Upsert result:", error || "Success");
}

run().catch(console.error);
