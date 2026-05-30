/**
 * S-ZK1 operator entrypoint — REST variant of scripts/anchor-zkp-epoch.ts for environments
 * WITHOUT a DATABASE_URL (direct-pg unavailable locally). It fetches proofs + back-fills
 * merkle_root via supabase-js (service-role key, which bypasses RLS), but computes the root +
 * EAS attestation with the SAME pure functions as the canonical script — so the merkle root and
 * the broadcast-ready calldata are byte-identical to `anchor-zkp-epoch.ts`.
 *
 *   ts-node scripts/anchor-zkp-epoch-via-rest.ts 2026-05-30 --after 26306            # DRY-RUN (default)
 *   ts-node scripts/anchor-zkp-epoch-via-rest.ts 2026-05-30 --after 26306 --apply    # back-fill merkle_root ONLY
 *
 * DRY-RUN by default; --apply persists merkle_root to repid_zkp_proofs ONLY. On-chain EAS send is
 * NEVER done here — Sean-only. Touches repid_zkp_proofs ONLY (never repid_score_events / agents /
 * the sync / compute_tier / HAL). Snapshot is FROZEN at fetch time (does not re-anchor late arrivals).
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { dayEpoch, epochLeaf, buildEasAttestationRequest, buildSeanCommand, buildMerkleProof, verifyMerkleProof } from '../src/services/zkp-epoch-anchor';
import { buildMerkleRoot } from '../src/services/audit-merkle-anchor';

function loadEnv() {
  const p = join(process.cwd(), '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = (m[2] ?? '').replace(/^["']|["']$/g, '');
  }
}
function argVal(flag: string): string | undefined { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined; }

async function main() {
  loadEnv();
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const dateArg = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
  const apply = process.argv.includes('--apply');
  const afterId = argVal('--after') ? parseInt(argVal('--after')!, 10) : 0;
  const epoch = dayEpoch(dateArg ? new Date(`${dateArg}T12:00:00.000Z`) : new Date());

  console.log(`[zkp-anchor/rest] epoch=${epoch.label} mode=${apply ? 'APPLY (writes merkle_root)' : 'DRY-RUN (no writes)'} afterId=${afterId}`);

  // 1. fetch the FROZEN snapshot: POSTCARD proofs in [start,end) with id > afterId, ordered by id.
  const rows: Array<{ id: number; zk_commitment: string }> = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('repid_zkp_proofs')
      .select('id, zk_commitment')
      .eq('proof_type', 'POSTCARD')
      .gt('id', afterId)
      .gte('created_at', epoch.start)
      .lt('created_at', epoch.end)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch failed: ${error.message}`);
    if (!data?.length) break;
    rows.push(...data as any[]);
    if (data.length < PAGE) break;
  }
  if (!rows.length) { console.log('[zkp-anchor/rest] no proofs in epoch — nothing to anchor.'); return; }

  // 2. freeze + 3. leaves + root (EXACT pure functions → byte-identical to canonical script)
  const ids = rows.map(r => r.id);
  const commitments = rows.map(r => r.zk_commitment);
  const leaves = commitments.map(epochLeaf);
  const root = buildMerkleRoot(leaves);
  const distinct = new Set(commitments).size;
  const firstId = ids[0]!, lastId = ids[ids.length - 1]!;

  console.log(JSON.stringify({ epoch: epoch.label, proof_count: rows.length, distinct_commitments: distinct, scheme: 'keccak256', merkle_root: root, first_id: firstId, last_id: lastId }, null, 2));
  if (distinct < rows.length) console.warn(`\n⚠️  ${rows.length - distinct}/${rows.length} DUPLICATE-commitment leaves — root well-formed but not per-proof-sound for those.`);
  else console.log(`✅ all ${rows.length} leaves are DISTINCT commitments — per-proof-sound (PR #74 nonce fix live for this epoch).`);

  // 5/6. EAS attestation (broadcast-ready) + Sean command
  const eas = buildEasAttestationRequest({ root, epoch: epoch.label, proofCount: rows.length, firstId, lastId });
  console.log('\n--- EAS attestation (broadcast-ready) ---');
  console.log(`eas_contract: ${eas.easContract}`);
  console.log(`schema_uid:   ${eas.schemaUid}`);
  console.log(`domain:       ${eas.domain}`);
  console.log(`calldata:     ${eas.attestCalldata}`);
  console.log('\n--- SEAN ON-CHAIN COMMAND (do NOT run unattended) ---');
  console.log(buildSeanCommand(eas, { firstId, lastId, idCount: rows.length }));

  // verify-back (independent of --apply): inclusion proof for leaf 0 must reproduce the root.
  const incl = buildMerkleProof(leaves, 0);
  console.log(`\n[verify-back] inclusion proof for id ${firstId}: reproduces_root=${verifyMerkleProof(incl)} root_match=${incl.root === root}`);

  // 7. persist merkle_root ONLY (Sean still does the on-chain send)
  if (apply) {
    let updated = 0;
    const B = 500;
    for (let i = 0; i < ids.length; i += B) {
      const batch = ids.slice(i, i + B);
      const { error, count } = await db.from('repid_zkp_proofs').update({ merkle_root: root }, { count: 'exact' }).in('id', batch);
      if (error) throw new Error(`back-fill failed at ${i}: ${error.message}`);
      updated += count ?? batch.length;
    }
    console.log(`\n[apply] merkle_root back-filled on ${updated}/${ids.length} rows (epoch ${epoch.label}, id ${firstId}..${lastId}).`);
  } else {
    console.log('\n[zkp-anchor/rest] DRY-RUN — re-run with --apply to persist merkle_root.');
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
