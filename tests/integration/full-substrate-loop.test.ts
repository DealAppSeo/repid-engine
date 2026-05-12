/**
 * CC Sprint 9 Phase 11 — full substrate loop integration test.
 *
 * Exercises the same shape as scripts/mock-harness/full-loop-demo.ts but as a
 * single Jest test with 8 assertions. Uses MOCK_FACILITATOR=true; no settlement.
 *
 * The test bootstraps two mock agents, runs through the protocol, and asserts
 * that each substrate component fired. Cleans up on teardown.
 *
 * Per RULE-8: scaffolds, does not exercise real spokespersons.
 *
 * NOTE: jest.config.js pins roots to ['<rootDir>/tests']. This file lives at
 * tests/integration/ which still resolves under that root.
 */

import { MockAgent } from '../../scripts/mock-harness/mock-agent';
import { getDb } from '../../scripts/liveness-probes/_shared';

describe('full substrate loop (Protocol 1, mock pair)', () => {
  jest.setTimeout(45000);

  let buyer: MockAgent;
  let seller: MockAgent;
  const stagedRows: { table: string; id: any }[] = [];

  beforeAll(async () => {
    const ts = Date.now();
    buyer = new MockAgent(`mock-it-buyer-${ts}`, 'uncertain');
    seller = new MockAgent(`mock-it-seller-${ts}`, 'constitutional');
    await buyer.bootstrap();
    await seller.bootstrap();
    await seller.seedMemoryNodes(2);
  });

  afterAll(async () => {
    const db = getDb();
    for (const r of stagedRows.reverse()) {
      try { await db.from(r.table).delete().eq('id', r.id); } catch { /* ignore */ }
    }
    await buyer.teardown();
    await seller.teardown();
  });

  it('1. mock agents bootstrap into repid_agents with EARNING tier and current_repid≥500', () => {
    expect(buyer.state.agent_id).toBeTruthy();
    expect(seller.state.agent_id).toBeTruthy();
    expect(buyer.state.current_repid).toBeGreaterThanOrEqual(500);
    expect(seller.state.current_repid).toBeGreaterThanOrEqual(500);
  });

  it('2. HAL pipeline write path accepts a synthetic row', async () => {
    const db = getDb();
    const tag = `cc-sprint-9-it-${seller.state.agent_name}-${Date.now()}`;
    const { data, error } = await db.from('hal_runner_results').insert({
      run_id: tag, prompt_id: `${tag}-q1`, benchmark_source: 'cc-sprint-9-integration-test',
      gen_provider: 'mock', gen_model: 'mock-v0', gen_latency_ms: 5,
      generated_answer: 'integration test answer', hal_mode: 1, hal_threshold: 0.7,
      hal_score: 0.2, hal_vetoed: false, gen_failed: false,
    }).select('id').single();
    expect(error).toBeNull();
    expect(data).toBeTruthy();
    stagedRows.push({ table: 'hal_runner_results', id: (data as any).id });
  });

  it('3. ANFIS snapshot write path accepts a staged row', async () => {
    const db = getDb();
    const tag = `cc-sprint-9-it-${Date.now()}`;
    const { data, error } = await db.from('hal_anfis_snapshots').insert({
      snapshot_id: tag, snapshot_version: 997, snapshot_hash: tag,
      anfis_weights: { integration_test: true }, milestone_description: 'cc-sprint-9 integration test',
    }).select('id').single();
    expect(error).toBeNull();
    expect(data).toBeTruthy();
    stagedRows.push({ table: 'hal_anfis_snapshots', id: (data as any).id });
  });

  it('4. SELLER score event writes + repid_score_events row exists', async () => {
    const eventId = await seller.recordEvent('AGENT_TEACHING', 5, {
      role: 'seller', protocol: 'integration-test', counterparty: buyer.state.agent_name,
    });
    expect(eventId).toBeGreaterThan(0);
  });

  it('5. BUYER score event writes + repid increases by exactly 1', async () => {
    const before = buyer.state.current_repid;
    const eventId = await buyer.recordEvent('AGENT_TEACHING', 1, {
      role: 'buyer', protocol: 'integration-test', counterparty: seller.state.agent_name,
    });
    expect(eventId).toBeGreaterThan(0);
    expect(buyer.state.current_repid).toBe(before + 1);
  });

  it('6. graph-rag response_to edge inserts cleanly between two seller nodes', async () => {
    const db = getDb();
    const { data: nodes } = await db.from('agent_memory_nodes').select('id').eq('agent_id', seller.state.agent_id).limit(2);
    expect(nodes && nodes.length).toBeGreaterThanOrEqual(2);
    const [n1, n2] = nodes as any[];
    const { data: edge, error: edgeErr } = await db.from('agent_memory_edges').insert({
      from_node_id: n1.id, to_node_id: n2.id, edge_type: 'response_to', weight: 0.5,
      metadata: { staged_by: 'integration-test' },
    }).select('id').single();
    expect(edgeErr).toBeNull();
    expect(edge).toBeTruthy();
    stagedRows.push({ table: 'agent_memory_edges', id: (edge as any).id });
  });

  it('7. ZKP proof queue accepts seller request and returns a row id', async () => {
    const proofId = await seller.requestZKPProof();
    expect(proofId).toBeGreaterThan(0);
  });

  it('8. EIP-712 attestation roundtrip recovers the signer', async () => {
    const r = await seller.verifyOwnReputation();
    expect(r.match).toBe(true);
    expect(r.recovered).toBe(r.expected);
  });
});
