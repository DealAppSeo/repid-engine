/**
 * CC Sprint 9 — MockAgent class.
 *
 * A single mock agent that exercises the full lifecycle:
 *   - bootstrap: register in repid_agents with mock UUID + name
 *   - makeDecision: behavior-profile-driven decision payload
 *   - attemptTrade: writes to trade_execution_log; Sprint 3 scoring fires
 *   - recordEvent: writes to repid_score_events with idempotency_key
 *   - requestZKPProof: queues a row in repid_proof_queue
 *   - verifyOwnReputation: EIP-712 attestation roundtrip
 *   - teardown: DELETE all rows this mock agent touched
 *
 * Discipline:
 *   - agent_name MUST start with 'mock-' (enforced)
 *   - never touches the 4 real spokesperson UUIDs
 *   - teardown is idempotent (safe to re-run)
 *
 * Per RULE-8: ships exactly what the dispatcher named.
 */

import { randomUUID } from 'crypto';
import { Wallet, verifyTypedData } from 'ethers';
import { getDb } from '../liveness-probes/_shared';
import { BehaviorProfile, AgentDecision, DecisionPayload, TradeOutcome, MockAgentState } from './types';

const FORBIDDEN_UUIDS = new Set([
  'f3ef0bf8-5cdc-4fad-bce8-5144f01dc271', // SOPHIA
  'a83cc9eb-43b0-49ee-9e45-2ecbb0d35067', // VERITAS
  '32e0e809-c1c4-4405-913f-135c8a2d6626', // SHOFET
  '2c2c24d6-2fd0-47e6-95d5-7fc9804a19e6', // CHESED
]);

export class MockAgent {
  state: MockAgentState;

  constructor(name: string, profile: BehaviorProfile) {
    if (!name.startsWith('mock-')) {
      throw new Error(`MockAgent name must start with 'mock-' (got: ${name})`);
    }
    this.state = {
      agent_id: randomUUID(),
      agent_name: name,
      current_repid: 500,
      tier: 'EARNING', // will be re-derived by trg_sync_tier
      behavior_profile: profile,
    };
    if (FORBIDDEN_UUIDS.has(this.state.agent_id)) {
      // Astronomically unlikely UUID collision but defensive
      throw new Error('Generated UUID collides with a spokesperson — refusing');
    }
  }

  /** Insert into repid_agents. Each MockAgent generates its own UUID; collisions
   *  are astronomically unlikely. Re-running scenarios produces new agents. */
  async bootstrap(): Promise<void> {
    const db = getDb();
    const { data, error } = await db.from('repid_agents').insert({
      id: this.state.agent_id,
      agent_name: this.state.agent_name,
      current_repid: this.state.current_repid,
      agent_type: 'external',
      constitution: { mock: true, profile: this.state.behavior_profile, version: 'cc-sprint-9' },
      is_human: false,
      // erc8004_address is NOT NULL — use a tagged synthetic value for mock agents
      // (real agents get a real wallet; mocks get a clearly-identifiable placeholder)
      erc8004_address: `mock:${this.state.agent_id}`,
    }).select('id, current_repid, tier').single();
    if (error) throw new Error(`MockAgent.bootstrap failed: ${error.message}`);
    if (data) {
      this.state.agent_id = (data as any).id;
      this.state.current_repid = (data as any).current_repid;
      this.state.tier = (data as any).tier;
    }
  }

  /** Deterministic-ish decision driven by behavior_profile. */
  makeDecision(prompt: string): DecisionPayload {
    const profile = this.state.behavior_profile;
    const seed = (prompt.length % 100) / 100; // poor-man's "randomness" — reproducible per prompt
    let decision: AgentDecision;
    let confidence: number;
    let reasoning: string;

    if (profile === 'constitutional' || profile === 'veto_heavy') {
      decision = seed > 0.3 ? 'REFUSED' : 'EXECUTE';
      confidence = 0.85;
      reasoning = decision === 'REFUSED' ? 'unity_score_below_threshold' : 'consensus_holds';
    } else if (profile === 'aggressive' || profile === 'trade_happy') {
      decision = seed > 0.15 ? 'EXECUTE' : 'REFUSED';
      confidence = 0.6;
      reasoning = decision === 'EXECUTE' ? 'momentum_aligned' : 'risk_excess';
    } else {
      // uncertain
      decision = seed > 0.5 ? 'EXECUTE' : 'REFUSED';
      confidence = 0.4;
      reasoning = 'mixed_signals';
    }
    return { decision, confidence, reasoning, asset: 'BTC', pair: 'BTC/USD', amount_usd: 100 };
  }

  /** Insert a synthetic trade row + return its id. */
  async attemptTrade(d: DecisionPayload): Promise<TradeOutcome> {
    const db = getDb();
    // Synthetic pnl for EXECUTE based on profile (tests +5/+15/-3/-10/-20 ladder)
    let pnl: number | null = null;
    if (d.decision === 'EXECUTE') {
      const map: Record<BehaviorProfile, number> = {
        constitutional: 3,         // small win when they DO execute
        aggressive: -8,           // moderate loss avg
        uncertain: 1,
        veto_heavy: 5,
        trade_happy: -25,         // severe loss avg
      };
      pnl = map[this.state.behavior_profile] ?? 0;
    }

    const { data, error } = await db.from('trade_execution_log').insert({
      agent_name: this.state.agent_name,
      decision: d.decision,
      asset: d.asset,
      pair: d.pair,
      action: 'BUY',
      amount_usd: d.amount_usd ?? 100,
      pnl_realized: pnl,
      execution_mode: 'paper',
      reason: `cc-sprint-9-mock: ${d.reasoning}`,
    }).select('id').single();
    if (error || !data) throw new Error(`MockAgent.attemptTrade failed: ${error?.message}`);

    return {
      trade_id: (data as any).id,
      agent_name: this.state.agent_name,
      decision: d.decision,
      pnl_realized: pnl,
      reason: d.reasoning,
    };
  }

  /** Insert a custom score event with proper idempotency_key. */
  async recordEvent(eventType: string, delta: number, metadata: Record<string, any>): Promise<number> {
    const db = getDb();
    const idemKey = `mock-${this.state.agent_name}-${eventType}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const before = this.state.current_repid;
    const after = Math.max(10, Math.min(10000, before + delta));
    const applied = after - before;

    const { data, error } = await db.from('repid_score_events').insert({
      agent_id: this.state.agent_id,
      event_type: eventType,
      delta: applied,
      repid_before: before,
      repid_after: after,
      repid_delta_calculated: delta,
      repid_delta_applied: applied,
      idempotency_key: idemKey,
      metadata: { ...metadata, source: 'mock-harness' },
    }).select('id').single();
    if (error || !data) throw new Error(`MockAgent.recordEvent failed: ${error?.message}`);

    if (applied !== 0) {
      await db.from('repid_agents').update({ current_repid: after }).eq('id', this.state.agent_id);
      this.state.current_repid = after;
    }
    return (data as any).id;
  }

  /** Queue a ZKP proof generation request.
   *  Schema (verified 2026-05-12): job_id is the required NOT NULL key; no proof_type column. */
  async requestZKPProof(): Promise<number> {
    const db = getDb();
    const job_id = `mock-${this.state.agent_id}-${Date.now()}`;
    const { data, error } = await db.from('repid_proof_queue').insert({
      agent_id: this.state.agent_id,
      job_id,
      status: 'pending',
    }).select('id').single();
    if (error || !data) throw new Error(`MockAgent.requestZKPProof failed: ${error?.message}`);
    return (data as any).id;
  }

  /** EIP-712 roundtrip: sign + verify own attestation. Hermetic (throwaway wallet). */
  async verifyOwnReputation(): Promise<{ recovered: string; expected: string; match: boolean }> {
    const signer = Wallet.createRandom();
    const domain = {
      name: 'HyperDAGRepIDAttestation',
      version: '1',
      chainId: 84532,
      verifyingContract: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    };
    const types = {
      Attestation: [
        { name: 'agent', type: 'string' },
        { name: 'repid', type: 'uint256' },
        { name: 'tier', type: 'string' },
        { name: 'timestamp', type: 'uint256' },
      ],
    };
    const message = {
      agent: this.state.agent_name,
      repid: BigInt(this.state.current_repid),
      tier: this.state.tier,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
    };
    const sig = await signer.signTypedData(domain, types, message);
    const recovered = verifyTypedData(domain, types, message, sig);
    return { recovered: recovered.toLowerCase(), expected: signer.address.toLowerCase(), match: recovered.toLowerCase() === signer.address.toLowerCase() };
  }

  /** Create 2 placeholder memory nodes so graph-rag scenarios can link them.
   *  Only used by scenarios that exercise the edge layer. */
  async seedMemoryNodes(count = 2): Promise<string[]> {
    const db = getDb();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const { data, error } = await db.from('agent_memory_nodes').insert({
        agent_id: this.state.agent_id,
        node_type: 'observation',
        content: `cc-sprint-9-mock-node-${i}`,
        importance: 0.1,
        metadata: { staged_by: 'mock-harness', synthetic: true },
      }).select('id').single();
      if (error || !data) throw new Error(`seedMemoryNodes(${i}) failed: ${error?.message}`);
      ids.push((data as any).id);
    }
    return ids;
  }

  /** Delete every row this mock agent created. Idempotent. */
  async teardown(): Promise<void> {
    const db = getDb();
    await db.from('repid_proof_queue').delete().eq('agent_id', this.state.agent_id);
    await db.from('repid_score_events').delete().eq('agent_id', this.state.agent_id);
    await db.from('agent_memory_edges').delete().or(`from_node_id.in.(select id from agent_memory_nodes where agent_id=${this.state.agent_id}),to_node_id.in.(select id from agent_memory_nodes where agent_id=${this.state.agent_id})`);
    await db.from('agent_memory_nodes').delete().eq('agent_id', this.state.agent_id);
    await db.from('trade_execution_log').delete().eq('agent_name', this.state.agent_name);
    await db.from('repid_agents').delete().eq('id', this.state.agent_id);
  }
}
