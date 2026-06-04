/**
 * R4 Live Gates Verifier
 * Run after npm ci + keys (local .env may differ; Railway/Strategy has HYPERDAG/EAS attestor + DB read).
 * Queries for EAS diagnosis: eas_anchored count, recent proofs with merkle but no uid, code_version if available.
 * RLS no-policy, etc.
 * Gate: LIVE numbers or BLOCKED.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

async function main() {
  const ts = new Date().toISOString();
  console.log(`[R4-LIVE-GATES] ${ts} xc5 ${process.env.npm_package_version || ''}`);
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.log('[R4-LIVE-GATES] BLOCKED: no DB read keys in shell/.env (Railway has them for live service; local shell differs per sprint). Ground: eas_anchored=0 despite key+merge 6d92490. Use Strategy/Supabase queries for verification.');
    console.log('After keys: npx ts-node scripts/verify/r4-live-gates.ts');
    process.exit(0);
  }
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // EAS anchored
  const { count: anchored } = await db.from('repid_zkp_proofs').select('*', { count: 'exact', head: true }).not('eas_attestation_uid', 'is', null);
  console.log(`[LIVE] eas_attestation_uid (anchored) >0 : ${anchored}`);

  // Recent merkle without uid (to see if firing)
  const { data: pending } = await db.from('repid_zkp_proofs').select('id, agent_id, tier_proven, merkle_root, created_at').not('merkle_root', 'is', null).is('eas_attestation_uid', null).order('created_at', { ascending: false }).limit(5);
  console.log(`[LIVE] recent merkle no uid (pending attest?): ${pending?.length || 0}`);
  (pending || []).forEach(p => console.log(`  ${p.id} ${p.agent_id} ${p.tier_proven} ${p.merkle_root?.slice(0,10)}... ${p.created_at}`));

  // is_human etc for ground
  const { count: humans } = await db.from('repid_agents').select('*', { count: 'exact', head: true }).eq('is_human', true);
  console.log(`[LIVE] is_human=true: ${humans}`);

  const { count: zkpCfg } = await db.from('zkp_routing_config').select('*', { count: 'exact', head: true });
  console.log(`[LIVE] zkp_routing_config: ${zkpCfg}`);

  // RLS no policy count approx (try pg_policies if accessible with service)
  try {
    const { count: policyCount } = await db.from('pg_policies' as any).select('*', { count: 'exact', head: true });
    console.log(`[LIVE] pg_policies rows: ${policyCount} (use for no-policy calc on 33)`);
  } catch (e) {
    console.log('[LIVE] pg_policies query not direct (use Supabase dashboard or raw for RLS-33 verify)');
  }

  // Check for code_version or deploy marker if table exists
  try {
    const { data: ver } = await db.from('deploy_canary' as any).select('*').limit(1);
    console.log(`[LIVE] deploy marker sample: ${JSON.stringify(ver)}`);
  } catch {}

  console.log('R4 gates verified or BLOCKED. Fix name mismatch in eas-service to HYPERDAG primary.');
}

main().catch(e => { console.error(e); process.exit(1); });
