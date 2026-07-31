/**
 * Bounded, credential-light proof-drain runner (2026-07-31).
 *
 * WHY THIS EXISTS ALONGSIDE sample-10-row-drain.ts: that harness (and the
 * deployed worker) reach the pending queue through `pgQuery` → direct-pg, which
 * requires DATABASE_URL (the Supabase transaction-pooler string). That variable
 * is not in .env.master, so the harness could not run locally — and, worse, its
 * absence used to kill the process SILENTLY (exit 0, no output; see
 * tests/direct-pg-config-failfast.test.ts and the fail-fast guard now in
 * src/db/direct-pg.ts).
 *
 * ProofDrainServiceConfig exposes `pgQueryImpl` for injection by design ("tests
 * pass a mock"). This runner injects a supabase-js-backed adapter for the ONE
 * hot query the drain issues, so a drain can run with only SUPABASE_URL +
 * service key — no pooler credential, no secret handling.
 *
 * Scope guard: the adapter implements ONLY the legacy pending-batch shape and
 * THROWS on any other SQL, so it can never silently answer a query it does not
 * understand (the whole point of this repo's no-silent-degradation rule).
 *
 * Run:
 *   ZKP_SERVICE_URL=https://zkp-postcard-production.up.railway.app \
 *   CC_DRAIN_BATCH=5 npx ts-node --transpile-only scripts/cc-drain-once.ts
 */
process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = 'true'; // THIS process only.

import { createProofDrainService } from '../src/services/proof-drain-service';
import { db } from '../src/db';

const ZKP_URL =
  process.env.ZKP_SERVICE_URL ||
  process.env.ZKP_POSTCARD_URL ||
  'https://zkp-postcard-production.up.railway.app';
const BATCH = Math.max(1, Number(process.env.CC_DRAIN_BATCH) || 5);

/** supabase-js adapter for the drain's single hot query. Throws on anything else. */
const pgQueryViaSupabase = (async (
  text: string,
  params: any[] = [],
  _opts: any = {}
): Promise<any[]> => {
  const normalized = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
  const isPendingBatch =
    normalized.includes('from repid_proof_queue') &&
    normalized.includes('status = $1') &&
    normalized.includes('zkp_service_url = $2');

  if (!isPendingBatch) {
    // Loud refusal beats a silent wrong answer.
    throw new Error(
      `[cc-drain-once] adapter only implements the legacy pending-batch query; refusing: ${normalized.slice(0, 120)}`
    );
  }

  const [status, url, limit] = params;
  // Newest-first is a deliberate choice for a TARGETED sample (the plain LIMIT
  // in the legacy SQL is unordered); it surfaces jobs from today's test agents
  // so the drained proof can be verified immediately end-to-end.
  const { data, error } = await db
    .from('repid_proof_queue')
    .select('id, job_id, agent_id, event_id, status')
    .eq('status', status)
    .eq('zkp_service_url', url)
    .order('created_at', { ascending: false })
    .limit(Number(limit) || BATCH);

  if (error) throw new Error(`[cc-drain-once] pending-batch query failed: ${error.message}`);
  return data ?? [];
}) as any;

async function main() {
  console.log(`[cc-drain-once] prover=${ZKP_URL} batch=${BATCH}`);

  const { count: pendingBefore } = await db
    .from('repid_proof_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
    .eq('zkp_service_url', ZKP_URL);
  console.log(`[cc-drain-once] pending before: ${pendingBefore}`);

  const svc = createProofDrainService({
    supabase: db,
    zkpServiceUrl: ZKP_URL,
    batchSize: BATCH,
    pgQueryImpl: pgQueryViaSupabase,
  });

  const result = await svc.drainOnce();
  console.log(`[cc-drain-once] drainOnce → completed=${result.jobsCompleted} failed=${result.jobsFailed}`);

  const { data: rows, error } = await db
    .from('repid_zkp_proofs')
    .select('agent_id, scheme, proof_type, proof_bytes, statement, leaf_scheme, poseidon2_leaf, created_at')
    .order('created_at', { ascending: false })
    .limit(BATCH);
  if (error) throw new Error(`verify-read failed: ${error.message}`);

  console.log(`\n[cc-drain-once] newest ${rows?.length ?? 0} rows in repid_zkp_proofs:`);
  for (const r of rows ?? []) {
    const bytes = typeof r.proof_bytes === 'string' ? r.proof_bytes.length : 0;
    console.log(
      `  agent=${r.agent_id} scheme=${r.scheme ?? 'NULL'} proof_bytes=${bytes ? bytes + ' b64chars' : 'NULL'} ` +
        `leaf=${r.leaf_scheme ?? 'NULL'} created=${r.created_at}`
    );
  }

  const { count: pendingAfter } = await db
    .from('repid_proof_queue')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
    .eq('zkp_service_url', ZKP_URL);
  console.log(`\n[cc-drain-once] pending after: ${pendingAfter} (was ${pendingBefore})`);
}

main()
  .then(() => console.log('[cc-drain-once] done'))
  .catch((e) => {
    console.error('[cc-drain-once] FAILED:', e?.message ?? e);
    console.error(e?.stack);
    process.exitCode = 1;
  });
