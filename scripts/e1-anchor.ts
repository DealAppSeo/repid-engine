/**
 * REPID-E1 commit-reveal anchor CLI (P2). DRY-RUN by default; the on-chain send is Sean-only.
 *
 *   # 1) COMMIT before any data (anchor the pre-registration bundle hash):
 *   npx ts-node scripts/e1-anchor.ts commit <run_id> <bundle.json>
 *
 *   # 2) REVEAL after the run (anchor the Merkle root of the run's output_hashes):
 *   #    leaves from a file: --hashes leaves.json  (JSON array of 0x… output_hash)
 *   #    or from the DB:     --from-db             (reads e1_response_ledger for the run)
 *   npx ts-node scripts/e1-anchor.ts reveal <run_id> <commit_uid> --hashes leaves.json
 *
 *   # add --send to BROADCAST (requires HYPERDAG_ATTESTOR_PRIVATE_KEY — Sean co-signs).
 *   # one-time: npx ts-node scripts/e1-anchor.ts register-schema
 */
import * as fs from 'fs';
import {
  computeCommitHash, merkleRoot, buildAttestation, sendAttestation,
  registerCommitRevealSchemaCommand, e1SchemaUid, type PreRegistrationBundle,
} from '../src/services/e1-commit-reveal';

const RPC = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
const nowSec = () => Math.floor(Date.now() / 1000);

async function leavesFromDb(runId: string): Promise<string[]> {
  // Lazy import so the CLI's commit path needs no DB/env. Reads the sealed ledger in deterministic order.
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL/SUPABASE_SERVICE_KEY required for --from-db');
  const db = createClient(url, key);
  const { data, error } = await db
    .from('e1_response_ledger')
    .select('output_hash, arm_id, task_id, replicate_idx')
    .eq('run_id', runId)
    .order('arm_id', { ascending: true }).order('task_id', { ascending: true }).order('replicate_idx', { ascending: true });
  if (error) throw new Error(`e1_response_ledger read failed (is the migration applied?): ${error.message}`);
  return (data ?? []).map((r: any) => r.output_hash);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const send = rest.includes('--send');

  if (cmd === 'register-schema') {
    console.log(registerCommitRevealSchemaCommand());
    return;
  }

  if (cmd === 'commit') {
    const [runId, bundlePath] = rest;
    if (!runId || !bundlePath) throw new Error('usage: commit <run_id> <bundle.json>');
    const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8')) as PreRegistrationBundle;
    const rootHash = computeCommitHash(bundle);
    const plan = buildAttestation({ phase: 'COMMIT', runId, rootHash, timestamp: nowSec(), artifactUri: bundlePath });
    console.log(`COMMIT  run=${runId}\n  commitHash = ${rootHash}\n  schemaUid  = ${plan.schemaUid}`);
    console.log(`\n${plan.castCommand}`);
    if (send) { const r = await sendAttestation(plan, RPC); console.log(`\nSENT uid=${r.uid} tx=${r.txHash}`); }
    else console.log('\n(DRY-RUN — pass --send to broadcast; on-chain send is Sean-only)');
    return;
  }

  if (cmd === 'reveal') {
    const [runId, commitUID] = rest;
    if (!runId || !commitUID) throw new Error('usage: reveal <run_id> <commit_uid> [--hashes f.json | --from-db]');
    let leaves: string[];
    const hi = rest.indexOf('--hashes');
    const hashFile = hi >= 0 ? rest[hi + 1] : undefined;
    if (hashFile) leaves = JSON.parse(fs.readFileSync(hashFile, 'utf8'));
    else if (rest.includes('--from-db')) leaves = await leavesFromDb(runId);
    else throw new Error('provide --hashes <file.json> or --from-db');
    const root = merkleRoot(leaves);
    const plan = buildAttestation({ phase: 'REVEAL', runId, rootHash: root, timestamp: nowSec(), commitUID });
    console.log(`REVEAL  run=${runId}  leaves=${leaves.length}\n  merkleRoot = ${root}\n  refUID(commit) = ${commitUID}\n  schemaUid  = ${plan.schemaUid}`);
    console.log(`\n${plan.castCommand}`);
    if (send) { const r = await sendAttestation(plan, RPC); console.log(`\nSENT uid=${r.uid} tx=${r.txHash}`); }
    else console.log('\n(DRY-RUN — pass --send to broadcast; on-chain send is Sean-only)');
    return;
  }

  console.log(`E1 anchor CLI. schemaUid=${e1SchemaUid()}\n  commands: commit | reveal | register-schema`);
}

main().catch((e) => { console.error('e1-anchor:', e.message); process.exit(1); });
