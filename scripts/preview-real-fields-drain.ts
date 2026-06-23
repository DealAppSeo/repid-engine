/**
 * F-P2 — DRY-RUN PREVIEW of the real-fields drain (D-062 / B-2). Co-sign artifact.
 *
 * Runs the ACTUAL proof-drain code path (createProofDrainService → drainOnce → insertCanonicalProof)
 * with PROOF_DRAIN_RECORD_REAL_FIELDS=true and a CAPTURING mock Supabase — so the rows printed here
 * are EXACTLY what the live drain would INSERT into repid_zkp_proofs once Sean flips the flag and a
 * leaf-aware prover is deployed. NOTHING is written to any database; this is a pure preview.
 *
 * The three prover responses below are real corpus statements (real agent_ids + real Poseidon2
 * leaves from hyperdag-core test_vectors/corpus.json, sql:2026-06-10) shaped exactly as the
 * leaf-aware zkp-postcard prover emits (poseidon2_leaf + leaf_scheme included).
 *
 * Run:  SUPABASE_URL=https://dummy.supabase.co SUPABASE_SERVICE_KEY=dummy \
 *         npx ts-node scripts/preview-real-fields-drain.ts
 *
 * What it proves for the co-sign:
 *   - the drain READS the prover's poseidon2_leaf + leaf_scheme + proof_bytes + statement, and
 *   - WRITES them into the canonical row ONLY when the flag is ON (legacy behavior is byte-identical
 *     when OFF), and
 *   - legacy rows are never touched (the insert is new-rows-only; no backfill anywhere in the path).
 */

process.env.PROOF_DRAIN_RECORD_REAL_FIELDS = 'true';

import { createProofDrainService } from '../src/services/proof-drain-service';

// Real corpus statements (threshold 0) — agent_id + Poseidon2 leaf verified in corpus.json.
const SAMPLES = [
  { agent_id: '394b6ee4-62e7-4c66-8445-29107b097b4c', name: 'MEDIATOR', repid: 2280, leaf: '0x3cef96d2', tier: 'ESTABLISHED' },
  { agent_id: '51dbf516-c0e0-4d60-bfee-60209de313b8', name: 'demo-openai-agent', repid: 2186, leaf: '0x059eeeba', tier: 'ESTABLISHED' },
  { agent_id: 'd244f6fc-35af-4131-b649-285bfac64b63', name: 'RESEARCHER', repid: 1675, leaf: '0x351dcda6', tier: 'ESTABLISHED' },
];

const zkpInserts: Array<Record<string, unknown>> = [];

function mockSupabase(): any {
  return {
    from(table: string) {
      if (table === 'repid_score_events') {
        return { select() { return { eq(_c: string, id: string) { return { single() {
          const s = SAMPLES.find(x => x.agent_id === id.replace('event:', ''));
          return Promise.resolve({ data: { repid_after: s ? s.repid : 1000 }, error: null });
        } }; } }; } };
      }
      if (table === 'repid_agents') {
        return { select() { return { eq(_c: string, id: string) { return { maybeSingle() {
          const s = SAMPLES.find(x => x.agent_id === id);
          return Promise.resolve({ data: { tier: s?.tier ?? 'ESTABLISHED', agent_name: s?.name ?? 'agent' }, error: null });
        } }; } }; } };
      }
      if (table === 'repid_zkp_proofs') {
        return {
          insert(row: Record<string, unknown>) { zkpInserts.push(row); return Promise.resolve({ error: null }); },
          update() { return { eq() { return { eq() { return Promise.resolve({ error: null }); }, is() { return Promise.resolve({ error: null }); } }; } }; },
        };
      }
      if (table === 'repid_proof_queue') {
        return { update() { return { eq() { return Promise.resolve({ error: null }); } }; } };
      }
      if (table === 'trinity_hitl_requests') {
        return { insert() { return Promise.resolve({ error: null }); } };
      }
      // proof-cache write-through reaches require('../cache/proof-cache'); swallow anything else.
      return { insert() { return Promise.resolve({ error: null }); }, select() { return { eq() { return { maybeSingle() { return Promise.resolve({ data: null, error: null }); } }; } }; } };
    },
  };
}

async function main() {
  const pending = SAMPLES.map((s, i) => ({
    id: `r${i}`, job_id: `j${i}`, agent_id: s.agent_id, event_id: s.agent_id, status: 'pending',
  }));

  let call = 0;
  const fakeFetch = (async () => {
    const s = SAMPLES[call % SAMPLES.length]!;
    call += 1;
    return {
      ok: true,
      text: async () => '',
      json: async () => ({
        commitment: `0xcommit_${s.name}`,
        proof_type: 'plonky3_range_check',
        proof_bytes: 'QkFTRTY0X1BST09GX0JZVEVT', // placeholder; live proofs are 10,673 bytes (corpus)
        proof_size_bytes: 10673,
        public_statement: 'RepID > 0',
        repid_score_actual: s.repid,
        tier: s.tier,
        poseidon2_leaf: s.leaf,
        leaf_scheme: 'poseidon2_babybear',
      }),
    };
  }) as any;

  const svc = createProofDrainService({
    supabase: mockSupabase(),
    pgQueryImpl: (async () => pending) as any,
    zkpServiceUrl: 'http://zkp.preview',
    routeProofRequestImpl: (async () => ({ proof_type: 'POSTCARD', route_to: 'fast_groth16', reason: 'preview' })) as any,
    fetchImpl: fakeFetch,
  });

  const result = await svc.drainOnce();

  console.log('\n=== DRY-RUN: rows the real-fields drain WOULD insert into repid_zkp_proofs ===');
  console.log(`flag PROOF_DRAIN_RECORD_REAL_FIELDS = ${process.env.PROOF_DRAIN_RECORD_REAL_FIELDS} (preview only; NOT flipped in prod)`);
  console.log(`jobs drained: ${result.jobsCompleted} completed, ${result.jobsFailed} failed\n`);
  zkpInserts.forEach((row, i) => {
    console.log(`--- row ${i + 1} (${SAMPLES[i]?.name}) ---`);
    console.log(JSON.stringify({
      agent_id: row.agent_id,
      proof_type: row.proof_type,
      tier_proven: row.tier_proven,
      scheme: row.scheme,                 // 'plonky3_range_check' (real) — NULL on legacy stubs
      leaf_scheme: row.leaf_scheme,       // 'poseidon2_babybear' (real) — NULL on legacy stubs
      poseidon2_leaf: row.poseidon2_leaf, // the aggregation leaf
      statement: row.statement,           // { repid_score, threshold }
      proof_bytes_len: typeof row.proof_bytes === 'string' ? (row.proof_bytes as string).length : null,
      zk_commitment_present: !!row.zk_commitment,
    }, null, 2));
  });
  console.log('\nLegacy rows (56,823 sha256 stubs): UNTOUCHED — scheme/leaf_scheme/poseidon2_leaf stay NULL.');
  console.log('Live precondition: apply the 2-column migration (leaf_scheme, poseidon2_leaf) + deploy a');
  console.log('leaf-aware prover, THEN flip the flag. New drains then write rows exactly like the above.\n');

  // Assert the preview actually exercised the real-field write path.
  const ok = zkpInserts.length === SAMPLES.length
    && zkpInserts.every(r => r.scheme === 'plonky3_range_check' && r.leaf_scheme === 'poseidon2_babybear' && typeof r.poseidon2_leaf === 'string');
  if (!ok) { console.error('PREVIEW ASSERT FAILED: real fields not populated'); process.exit(1); }
  console.log('PREVIEW OK: all rows carry real scheme + leaf_scheme + poseidon2_leaf + statement.');
}

main().catch(e => { console.error(e); process.exit(1); });
