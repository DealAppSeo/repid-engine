/**
 * CC Sprint 9 Phase 8 — Full-loop demo (MICRO_TX Protocol 1, 17 steps).
 *
 * Executes the canonical agent-to-agent Q&A protocol end-to-end between
 * TWO MOCK AGENTS. Demonstrates every substrate component fires.
 *
 * MOCK_FACILITATOR toggle:
 *   - default (true): x402 facilitator is mocked locally; no USDC moves.
 *   - set to 'false' (via `npm run demo:full-loop:real`): wires the real facilitator.
 *     The real path is GATED by the circuit breaker `cb_disable_x402_settlements`
 *     which defaults to TRIPPED — so even with MOCK_FACILITATOR=false, the path
 *     short-circuits unless Sean explicitly resumes the breaker.
 *
 * Each of the 17 steps logs a status line. Failures are captured but do not
 * halt the script — every step's outcome is included in the final report so
 * Sean can read the whole story.
 *
 * Per RULE-8: this demo is scaffolding. Real Protocol 1 between real
 * spokespersons is a Phase D decision (see SWARM_WAKEUP_SEQUENCE_2026-05-12.md).
 */

import 'dotenv/config';
import { MockAgent } from './mock-agent';
import { getDb } from '../liveness-probes/_shared';

interface StepResult {
  step: number;
  name: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];
const log = (step: number, name: string, ok: boolean, detail: string) => {
  results.push({ step, name, ok, detail });
  const mark = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} [${String(step).padStart(2, '0')}] ${name}${detail ? ' — ' + detail : ''}`);
};

const MOCK_FACILITATOR = (process.env.MOCK_FACILITATOR ?? 'true').toLowerCase() !== 'false';

(async () => {
  console.log(`[full-loop-demo] MOCK_FACILITATOR=${MOCK_FACILITATOR} (real path requires Sean to flip cb_disable_x402_settlements)`);

  const db = getDb();
  const ts = Date.now();
  const buyer = new MockAgent(`mock-fl-buyer-${ts}`, 'uncertain');
  const seller = new MockAgent(`mock-fl-seller-${ts}`, 'constitutional');

  // ── Step 01 ── Bootstrap both agents
  try { await buyer.bootstrap(); await seller.bootstrap(); log(1, 'Bootstrap pair', true, `buyer=${buyer.state.agent_name} seller=${seller.state.agent_name}`); }
  catch (e: any) { log(1, 'Bootstrap pair', false, e.message); return finalize(); }

  // ── Step 02 ── BUYER submits a question (synthetic; no real API)
  const question = 'What is the current ETH price band per HAL?';
  log(2, 'BUYER submits question', true, `"${question}"`);

  // ── Step 03 ── HAL pipeline classifies (staged hal_runner_results row)
  const halRunStart = new Date().toISOString();
  let halRunId: string | null = null;
  // hal_runner_results minimal schema (verified 2026-05-12): run_id, prompt_id, benchmark_source.
  // It's a benchmark/HAL run-log, not a per-agent event log — so we tag the run_id with the mock agent name.
  try {
    const runTag = `cc-sprint-9-fl-${seller.state.agent_name}-${ts}`;
    const { data, error } = await db.from('hal_runner_results').insert({
      run_id: runTag,
      prompt_id: `${runTag}-q1`,
      benchmark_source: 'cc-sprint-9-mock-harness',
      gen_provider: 'mock',
      gen_model: 'mock-v0',
      gen_latency_ms: 12,
      generated_answer: 'staged answer for full-loop-demo',
      hal_mode: 1,
      hal_threshold: 0.7,
      hal_score: 0.2,
      hal_vetoed: false,
      gen_failed: false,
    }).select('id').single();
    if (error) throw new Error(error.message);
    halRunId = (data as any).id;
    log(3, 'HAL pipeline classifies', true, `hal_runner_results id=${halRunId}`);
  } catch (e: any) { log(3, 'HAL pipeline classifies', false, e.message); }

  // ── Step 04 ── ANFIS routing (staged snapshot)
  let anfisSnapshotId: string | null = null;
  try {
    const tag = `cc-sprint-9-fl-${ts}`;
    const { data, error } = await db.from('hal_anfis_snapshots').insert({
      snapshot_id: tag,
      snapshot_version: 998,
      snapshot_hash: tag,
      anfis_weights: { staged: true, source: 'cc-sprint-9-full-loop-demo' },
      milestone_description: 'cc-sprint-9 full-loop-demo staged snapshot — safe to delete',
    }).select('id').single();
    if (error) throw new Error(error.message);
    anfisSnapshotId = (data as any).id;
    log(4, 'ANFIS routing selects provider', true, `snapshot id=${anfisSnapshotId}`);
  } catch (e: any) { log(4, 'ANFIS routing selects provider', false, e.message); }

  // ── Step 05 ── SELLER drafts answer (synthetic decision)
  const decision = seller.makeDecision(question);
  log(5, 'SELLER drafts answer', true, `decision=${decision.decision} confidence=${decision.confidence}`);

  // ── Step 06 ── HAL evaluates hallucination risk (synthetic; mock low risk)
  const halRisk = decision.decision === 'REFUSED' ? 0.2 : 0.55;
  log(6, 'HAL evaluates hallucination risk', true, `risk=${halRisk.toFixed(2)}`);

  // ── Step 07 ── Quality gate (HAL_RISK_THRESHOLD = 0.7 → mock answers always pass)
  const answerPasses = halRisk < 0.7;
  log(7, 'Quality gate', answerPasses, `passes=${answerPasses}`);

  // ── Step 08 ── BUYER contextual evaluator scores answer
  const sellerDelta = answerPasses ? (decision.decision === 'REFUSED' ? 2 : 5) : -3;
  log(8, 'BUYER scores answer', true, `seller_delta=${sellerDelta}`);

  // ── Step 09 ── SELLER score event
  try {
    const id = await seller.recordEvent('AGENT_TEACHING', sellerDelta, {
      role: 'seller',
      counterparty: buyer.state.agent_name,
      hal_risk: halRisk,
      protocol: 'cc-sprint-9-full-loop-p1',
    });
    log(9, 'SELLER score event written', true, `event id=${id} repid=${seller.state.current_repid}`);
  } catch (e: any) { log(9, 'SELLER score event written', false, e.message); }

  // ── Step 10 ── BUYER score event (+1 for constructive participation)
  try {
    const id = await buyer.recordEvent('AGENT_TEACHING', 1, {
      role: 'buyer',
      counterparty: seller.state.agent_name,
      protocol: 'cc-sprint-9-full-loop-p1',
    });
    log(10, 'BUYER score event written', true, `event id=${id} repid=${buyer.state.current_repid}`);
  } catch (e: any) { log(10, 'BUYER score event written', false, e.message); }

  // ── Step 11 ── graph-rag adds response_to edge between two of seller's nodes
  // seed 2 nodes for the mock seller first (real agents already have rich graph state)
  let edgeId: string | null = null;
  try {
    await seller.seedMemoryNodes(2);
    const { data: nodes } = await db.from('agent_memory_nodes').select('id').eq('agent_id', seller.state.agent_id).limit(2);
    if (!nodes || nodes.length < 2) {
      log(11, 'graph-rag response_to edge', false, 'seller node seed failed unexpectedly');
    } else {
      const [n1, n2] = nodes as any[];
      const { data, error } = await db.from('agent_memory_edges').insert({
        from_node_id: n1.id, to_node_id: n2.id, edge_type: 'response_to', weight: 0.5,
        metadata: { staged_by: 'cc-sprint-9-full-loop-demo' },
      }).select('id').single();
      if (error) throw new Error(error.message);
      edgeId = (data as any).id;
      log(11, 'graph-rag response_to edge', true, `edge id=${edgeId}`);
    }
  } catch (e: any) { log(11, 'graph-rag response_to edge', false, e.message); }

  // ── Step 12 ── ZKP proof queued (both agents)
  let sellerProofId: number | null = null;
  let buyerProofId: number | null = null;
  try {
    sellerProofId = await seller.requestZKPProof();
    buyerProofId = await buyer.requestZKPProof();
    log(12, 'ZKP proofs queued', true, `seller queue id=${sellerProofId} buyer queue id=${buyerProofId}`);
  } catch (e: any) { log(12, 'ZKP proofs queued', false, e.message); }

  // ── Step 13 ── EIP-712 attestation roundtrip (hermetic, signer=throwaway)
  try {
    const r = await seller.verifyOwnReputation();
    log(13, 'EIP-712 attestation roundtrip', r.match, r.match ? `signer matches recovered` : `MISMATCH ${r.recovered} vs ${r.expected}`);
  } catch (e: any) { log(13, 'EIP-712 attestation roundtrip', false, e.message); }

  // ── Step 14 ── x402 settlement (gated)
  if (MOCK_FACILITATOR) {
    log(14, 'x402 settlement', true, 'MOCK_FACILITATOR — no USDC moved');
  } else {
    log(14, 'x402 settlement', false, 'real facilitator path requires cb_disable_x402_settlements=false AND Sean approval — Sprint 9 does not authorize this');
  }

  // ── Step 15 ── Update repid_ecosystem_supply counter (synthetic increment)
  log(15, 'ecosystem supply rate', true, 'skipped — synthetic events do not bump supply');

  // ── Step 16 ── Probe substrate post-write
  try {
    const { count: events } = await db.from('repid_score_events').select('*', { count: 'exact', head: true });
    log(16, 'probe substrate post-write', true, `repid_score_events total=${events}`);
  } catch (e: any) { log(16, 'probe substrate post-write', false, e.message); }

  // ── Step 17 ── Cleanup (teardown mock agents + ancillary rows we created)
  try {
    if (halRunId) await db.from('hal_runner_results').delete().eq('id', halRunId);
    if (anfisSnapshotId) await db.from('hal_anfis_snapshots').delete().eq('id', anfisSnapshotId);
    if (edgeId) await db.from('agent_memory_edges').delete().eq('id', edgeId);
    await buyer.teardown();
    await seller.teardown();
    log(17, 'cleanup', true, 'all staged rows + mock agents removed');
  } catch (e: any) { log(17, 'cleanup', false, e.message); }

  finalize();
})().catch((e) => { console.error('full-loop-demo crashed:', e); process.exit(1); });

function finalize() {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n[full-loop-demo] ${passed}/${results.length} steps SUCCESS`);
  if (passed < results.length) {
    console.log('[full-loop-demo] FAILED STEPS:');
    for (const r of results) if (!r.ok) console.log(`    ${r.step}. ${r.name} — ${r.detail}`);
  }
  process.exit(passed === results.length ? 0 : 1);
}
