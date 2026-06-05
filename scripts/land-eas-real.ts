/**
 * R3 EAS real-ready land script.
 * - Deletes/ignores any borrowed UID backfill (none staged here; previous fake ones removed per CC).
 * - Uses eas-attestation-service to attest OUR merkle_root + HyperDAG payload.
 * - After Sean EAS_ATTESTER_PRIVATE_KEY (funded), run this.
 * - Red-teams the 5: on-chain payload decode == DB merkle_root etc.
 * - Gate: live eas_attestation_uid count >0 with match evidence, or BLOCKED (no key).
 */
import 'dotenv/config';
import { easService } from '../src/services/eas-attestation-service';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

async function main() {
  const ts = new Date().toISOString();
  console.log(`[LAND-EAS-REAL R3] ${ts} xc4`);

  if (!easService.hasAttesterKey()) {
    console.log('[LAND-EAS-REAL] BLOCKED: no EAS_ATTESTER_PRIVATE_KEY (Sean: provision funded Base Sepolia key)');
    console.log('After key: npx ts-node scripts/land-eas-real.ts');
    process.exit(0);
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.log('[LAND-EAS-REAL] BLOCKED: no DB keys for query/update');
    process.exit(0);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: cands } = await db
    .from('repid_zkp_proofs')
    .select('id, agent_id, tier_proven, merkle_root, zk_commitment')
    .not('merkle_root', 'is', null)
    .is('eas_attestation_uid', null)
    .order('created_at', { ascending: false })
    .limit(6);

  const toDo = (cands || []).slice(0, 5);
  console.log(`[LAND-EAS-REAL] attesting ${toDo.length} own merkle proofs (HyperDAG-bound)`);

  const results: any[] = [];
  for (const r of toDo) {
    let repidSnap: number | null = null;
    try {
      const { data: ev } = await db.from('repid_score_events').select('repid_after').eq('agent_id', r.agent_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      repidSnap = (ev as any)?.repid_after || null;
    } catch {}

    const res = await easService.attestProof({
      proofId: r.id,
      agentId: r.agent_id || 'unknown',
      tier: r.tier_proven || 'EARNING',
      merkleRoot: r.merkle_root,
      repidSnapshot: repidSnap,
      proofType: 'POSTCARD'
    });
    if (res.uid) {
      await db.from('repid_zkp_proofs').update({ eas_attestation_uid: res.uid, eas_schema: 'constitutional-compliance-v1' }).eq('id', r.id);
      console.log(`  ATTESTED id=${r.id} uid=${res.uid} tx=${res.txHash}`);
      results.push({ ...r, uid: res.uid, tx: res.txHash });
    } else {
      console.log(`  SKIP id=${r.id}: ${res.error}`);
    }
  }

  console.log('\n[RED-TEAM own 5 UIDs payload-match]');
  for (const r of results) {
    const proofRow = { id: r.id, agent_id: r.agent_id, tier_proven: r.tier_proven, merkle_root: r.merkle_root, eas_attestation_uid: r.uid };
    const rt = await easService.redTeamPayloadMatch(proofRow as any);
    console.log(`  uid=${r.uid} match=${rt.match} ${rt.details}`);
    if (rt.explorer) console.log(`    ${rt.explorer}`);
  }

  const { count } = await db.from('repid_zkp_proofs').select('*', { count: 'exact', head: true }).not('eas_attestation_uid', 'is', null);
  console.log(`\n[LIVE] eas_attestation_uid >0 now: ${count}`);
  console.log('If >0 and 5 matches: R3 EAS real-ready gate passed with own HyperDAG UIDs (no borrowed).');
}

main().catch(e => { console.error(e); process.exit(1); });
