/**
 * B — 10-ROW REAL-SAMPLE DRAIN HARNESS (Sean-gated). Turns "1 → 8,000+" from hypothesis to FACT.
 *
 * ⚠️ THIS WRITES 10 REAL ROWS TO PROD `repid_zkp_proofs`. It is the ONE controlled sample that proves
 * the real-fields drain produces genuine, WASM-verifiable Plonky3 rows. DO NOT run it until ALL of:
 *   1. the 2026-06-08-zkp-circuits-domain migration is APPLIED (adds leaf_scheme + poseidon2_leaf cols),
 *   2. the HEALTHY, leaf-aware prover is deployed (emits proof_type=plonky3_range_check + poseidon2_leaf),
 *   3. you accept it will mark 10 pending repid_proof_queue items completed + insert 10 canonical rows.
 * It does NOT flip the deployed worker's flag (it sets PROOF_DRAIN_RECORD_REAL_FIELDS only in THIS
 * process, for THIS one drainOnce of ≤10 items). Run it as the sole drainer (or accept the prod worker
 * may claim some of the 10). Sean runs this; CC stages it.
 *
 * Run (after the gates):
 *   PROOF_DRAIN_RECORD_REAL_FIELDS=true SUPABASE_URL=… SUPABASE_SERVICE_KEY=… \
 *   ZKP_SERVICE_URL=https://<healthy-leaf-aware-prover> npx ts-node scripts/sample-10-row-drain.ts
 *
 * Asserts, for each of the 10 drained rows:
 *   - scheme === 'plonky3_range_check'  (REAL, not a sha256 stub)
 *   - proof_bytes IS NOT NULL           (real STARK bytes persisted)
 *   - leaf_scheme === 'poseidon2_babybear' + poseidon2_leaf present  (aggregation-ready)
 *   - the proof VERIFIES via @hyperdag/proof-verifier against its {agent_id, repid_score, threshold}
 * Prints the 10 rows + PASS/FAIL + a one-line verdict.
 */

process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = 'true'; // THIS PROCESS ONLY — not the deployed worker.

import { createProofDrainService } from '../src/services/proof-drain-service';
import { db } from '../src/db';
import { pgQuery } from '../src/db/direct-pg';

const SAMPLE_N = 10;
const ZKP_URL = process.env.ZKP_SERVICE_URL || process.env.ZKP_POSTCARD_URL || '';

async function recentRealRows(sinceIso: string): Promise<any[]> {
  return pgQuery<any>(
    `SELECT id, agent_id, scheme, leaf_scheme, poseidon2_leaf, proof_bytes, statement, created_at
       FROM repid_zkp_proofs
      WHERE created_at >= $1 AND scheme = 'plonky3_range_check'
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [sinceIso, SAMPLE_N],
    { retries: 2, label: 'sample-10-recent' },
  );
}

async function main() {
  if (!ZKP_URL) { console.error('FAIL: set ZKP_SERVICE_URL to the healthy leaf-aware prover'); process.exit(1); }

  // Baseline: how many real rows exist now, and how deep is the pending queue.
  const [{ real_before }] = await pgQuery<any>(`SELECT count(*)::int AS real_before FROM repid_zkp_proofs WHERE scheme IS NOT NULL`, [], { label: 'baseline-real' });
  const [{ pending }] = await pgQuery<any>(`SELECT count(*)::int AS pending FROM repid_proof_queue WHERE status='pending' AND zkp_service_url=$1`, [ZKP_URL], { label: 'baseline-pending' });
  console.log(`baseline: ${real_before} real rows, ${pending} pending for ${ZKP_URL}`);
  if (pending === 0) { console.error('FAIL: no pending items to drain for this prover URL'); process.exit(1); }

  const sinceIso = new Date(Date.now() - 5000).toISOString();

  // Drain EXACTLY ≤10 (batchSize bounds the single drainOnce).
  const svc = createProofDrainService({ supabase: db, zkpServiceUrl: ZKP_URL, batchSize: SAMPLE_N });
  const result = await svc.drainOnce();
  console.log(`drainOnce: ${result.jobsCompleted} completed, ${result.jobsFailed} failed`);

  // Verify what landed.
  const rows = await recentRealRows(sinceIso);
  const { verify } = await import('@hyperdag/proof-verifier');

  let pass = 0;
  for (const r of rows) {
    const checks: string[] = [];
    const schemeOk = r.scheme === 'plonky3_range_check'; checks.push(`scheme=${r.scheme}${schemeOk ? '✓' : '✗'}`);
    const bytesOk = r.proof_bytes != null && String(r.proof_bytes).length > 0; checks.push(`proof_bytes=${bytesOk ? 'present✓' : 'NULL✗'}`);
    const leafOk = r.leaf_scheme === 'poseidon2_babybear' && !!r.poseidon2_leaf; checks.push(`leaf=${r.leaf_scheme}/${r.poseidon2_leaf || 'NULL'}${leafOk ? '✓' : '✗'}`);
    let verifyOk = false;
    try {
      const stmt = typeof r.statement === 'string' ? JSON.parse(r.statement) : r.statement;
      const proofBytes = Buffer.from(String(r.proof_bytes), 'base64');
      const v: any = await verify(new Uint8Array(proofBytes), { agent_id: r.agent_id, repid_score: stmt?.repid_score, threshold: stmt?.threshold, tier: '' });
      verifyOk = !!v?.verified;
    } catch (e) { checks.push(`verify_threw=${(e as Error).message}`); }
    checks.push(`wasm_verify=${verifyOk ? 'true✓' : 'false✗'}`);

    const rowPass = schemeOk && bytesOk && leafOk && verifyOk;
    if (rowPass) pass++;
    console.log(`${rowPass ? 'PASS' : 'FAIL'} id=${r.id} agent=${r.agent_id} ${checks.join(' ')}`);
  }

  console.log(`\n=== ${pass}/${rows.length} rows PASS (drained ${result.jobsCompleted}) ===`);
  console.log(pass === rows.length && rows.length > 0
    ? `VERDICT: the real-fields drain produces genuine WASM-verifiable Plonky3 rows. 1 → ${real_before + rows.length}+ is FACT.`
    : `VERDICT: NOT all rows passed — inspect above before flipping the deployed worker's flag.`);
  process.exit(pass === rows.length && rows.length > 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
