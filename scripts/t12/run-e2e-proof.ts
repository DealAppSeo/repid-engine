/**
 * S-R3 Phase 3 gate — run the T12 on-chain E2E proof harness once against staging and write a
 * t12_e2e_proofs ledger row with the artifacts it can currently produce (HAL + RepID real; x402 tx
 * simulated under MOCK_FACILITATOR; EAS uid null until the attester key lands).
 *
 * Uses an isolated synth agent (trinity-t12-e2e, 600 with floor headroom). Run:
 *   MOCK_FACILITATOR=true ts-node scripts/t12/run-e2e-proof.ts
 */
import { db } from '../../src/db';
import { runE2EProof } from '../../src/testing/t12-e2e-proof';

const BASE = 't12-e2e';

async function ensureAgent(base: string, repid: number): Promise<string> {
  const { data: prior } = await db.from('repid_agents').select('id').ilike('agent_name', `%${base}`);
  for (const p of (prior ?? []) as any[]) await db.from('repid_score_events').delete().eq('agent_id', p.id);
  await db.from('repid_agents').delete().ilike('agent_name', `%${base}`);
  await db.from('repid_agents').insert({ agent_name: base, erc8004_address: '0x00000000000000000000000000000000000000e2', current_repid: repid, peak_repid: repid });
  const { data } = await db.from('repid_agents').select('agent_name').ilike('agent_name', `%${base}`).maybeSingle();
  return (data as any)?.agent_name as string;
}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const agent = await ensureAgent(BASE, 600);
  console.log(`[t12-e2e] subject agent: ${agent} (600, floor 500). run=${stamp}`);

  const proof = await runE2EProof({
    runId: stamp, agent,
    output: 'Paris is the capital of France, and the Eiffel Tower was completed in 1889.',
    counterparty: 'trinity-sophia', amountUsdc: 0.1,
  });

  console.log('\n=== E2E PROOF LEDGER ROW ===');
  console.log(`  ledger id      : ${proof.id}`);
  console.log(`  status         : ${proof.proof_status}`);
  console.log(`  stages_real    : ${JSON.stringify(proof.stages_real)}`);
  console.log(`  1 verifyOutput : hal_score=${proof.hal_score} verdict=${proof.hal_verdict}`);
  console.log(`  2 executeA2A   : x402_tx=${proof.x402_tx_hash ?? 'null'} src=${proof.x402_settlement_source}`);
  console.log(`  3 RepID delta  : event_id=${proof.repid_event_id} delta=${proof.repid_delta}`);
  console.log(`  4 presentProof : zkp_id=${proof.zkp_proof_id} eas_uid=${proof.eas_attestation_uid ?? 'null (key pending)'}`);

  // SQL read-back verification.
  const { data: row } = await db.from('t12_e2e_proofs').select('id, hal_score, x402_tx_hash, repid_event_id, eas_attestation_uid, proof_status, stages_real').eq('run_id', stamp).maybeSingle();
  console.log('\n=== read-back from t12_e2e_proofs ===');
  console.log(`  ${JSON.stringify(row)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
