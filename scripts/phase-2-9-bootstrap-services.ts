import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY!;
const db = createClient(supabaseUrl, supabaseKey);

const TRINITY_AGENTS = [
  'trinity-orch', 'trinity-w3c', 'trinity-shofet',
  'trinity-torch', 'trinity-veritas', 'trinity-gcm',
  'trinity-chesed', 'trinity-mel', 'trinity-apm',
  'trinity-sophia', 'trinity-nexus', 'trinity-hdm',
];

async function registerService(agentName: string, serviceType: string, serviceName: string, basePriceUsdcRaw: number) {
  const { data: agent, error: agentErr } = await db.from('repid_agents').select('id').eq('agent_name', agentName).single();
  
  if (agentErr || !agent) {
    console.log(`Failed to find agent ${agentName}`);
    return;
  }

  // Check idempotent
  const { data: existing } = await db.from('agent_services')
    .select('id')
    .eq('provider_agent_id', agent.id)
    .eq('service_type', serviceType)
    .maybeSingle();
    
  if (existing) {
    console.log(`[SKIPPED] ${agentName} already registered for ${serviceType}`);
    return;
  }

  const { error } = await db.from('agent_services').insert({
    provider_agent_id: agent.id,
    service_type: serviceType,
    service_name: serviceName,
    base_price_usdc_raw: basePriceUsdcRaw,
    min_repid_to_purchase: 500
  });

  if (error) {
    console.error(`[ERROR] registering ${serviceType} for ${agentName}:`, error.message);
  } else {
    console.log(`[SUCCESS] Registered ${serviceType} for ${agentName} at ${basePriceUsdcRaw} USDC`);
  }
}

async function run() {
  console.log('Bootstrapping agent services...');
  
  for (const agentName of TRINITY_AGENTS) {
    await registerService(agentName, 'verification', 'Constitutional Verification', 100000);
    await registerService(agentName, 'cross_validation', 'PCP+Judge Cross-Validation', 500000);
  }

  // Specialist services
  await registerService('trinity-veritas', 'reputation_audit', 'Signed Reputation Attestation', 500000);
  await registerService('trinity-mel', 'anfis_routing', 'ANFIS Routing Advisory', 50000);
  await registerService('trinity-hdm', 'decentralized_storage', 'Artifact Storage', 200000);
  
  console.log('Done bootstrapping services.');
}

run().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
