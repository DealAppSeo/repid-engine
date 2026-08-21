/**
 * shadow-scoring.test.ts — the wiring that must move nothing.
 *
 * Every fixture here uses a FABRICATED NIL-variant agent id. PR #376 committed a
 * proof lifted from the production table into this public repository and it
 * cannot be withdrawn; `scripts/hooks/prod-fixture-guard.js` blocks that shape
 * permanently. No value in this file may be one a real agent could hold.
 */
import { OutcomeClass } from '../src/services/outcome-classification';
import { RiskBand } from '../src/services/risk-tier';
import {
  EVENT_TYPE_BY_OUTCOME,
  SHADOW_EVENT_SCHEMA,
  buildShadowScoreEvent,
  roundHalfAwayFromZero,
  shadowIdempotencyKey,
  type SettledInteraction,
} from '../src/services/shadow-scoring';

const PROVIDER = '00000000-0000-0000-0000-000000000001';
const CONSUMER = '00000000-0000-0000-0000-000000000002';
const BUILDER = '00000000-0000-0000-0000-000000000003';
const CONTRACT = '00000000-0000-0000-0000-000000000004';
const PROOF_HASH = '0x' + 'ab'.repeat(32);

function interaction(over: Partial<SettledInteraction> = {}): SettledInteraction {
  return {
    interactionId: 'fabricated-interaction-1',
    providerAgentId: PROVIDER,
    consumerAgentId: CONSUMER,
    builderId: BUILDER,
    contractId: CONTRACT,
    outcomeClass: OutcomeClass.SUCCESS_AUDITED,
    halCalibratedConfidence: 0.9,
    validationResponse: 95,
    serviceValueUsdc: 250,
    stakeExposedUsdc: 400,
    priorInteractions: 12,
    paymentProof: { txHash: PROOF_HASH, chainId: 84532, verified: true },
    ...over,
  };
}

describe('the integer ledger cannot hold the deltas the policy computes', () => {
  /**
   * MEASURED 2026-08-21, in a rolled-back transaction: `repid_score_events.delta`
   * is `integer`, and Postgres casts numeric to integer by rounding half AWAY
   * FROM ZERO. These five probes are the observed outputs, reproduced in app
   * code so the value written is the value chosen.
   */
  it('rounds by the rule Postgres actually uses, not the rule JavaScript defaults to', () => {
    expect(roundHalfAwayFromZero(-24.75)).toBe(-25);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1); // Math.round(-0.5) is -0 — the divergence
    expect(roundHalfAwayFromZero(0.4)).toBe(0);
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(2.4)).toBe(2);
  });

  it('normalises negative zero, because Postgres has none', () => {
    expect(Object.is(roundHalfAwayFromZero(-0.2), 0)).toBe(true);
    expect(Object.is(roundHalfAwayFromZero(-0), 0)).toBe(true);
  });

  it('keeps a non-finite delta visible instead of quietly turning it into zero', () => {
    expect(Number.isNaN(roundHalfAwayFromZero(NaN))).toBe(true);
  });

  it('preserves the exact delta losslessly beside the quantised one', () => {
    // FAILURE_COUNTERPARTY is specified as a -0.5 "whisper". The column doubles
    // it to -1 and cannot represent the original. Replay reads the exact value.
    const r = buildShadowScoreEvent(
      interaction({ outcomeClass: OutcomeClass.FAILURE_COUNTERPARTY, halCalibratedConfidence: 0.5 }),
    );
    expect(r.delta.delta).toBe(-0.5);
    expect(r.row.delta).toBe(-1);
    expect(r.row.metadata['delta_exact_fp100']).toBe(-50);
    expect(r.row.metadata['delta_rounding_loss_fp100']).toBe(50);
  });

  it('records zero rounding loss when the policy delta was already whole', () => {
    const r = buildShadowScoreEvent(
      interaction({ outcomeClass: OutcomeClass.REFUSED_CORRECTLY, halCalibratedConfidence: 0.5 }),
    );
    expect(r.delta.delta).toBe(2);
    expect(r.row.delta).toBe(2);
    expect(r.row.metadata['delta_rounding_loss_fp100']).toBe(0);
  });
});

describe('shadow mode moves nothing', () => {
  it('marks the row with the dedicated column, never by overloading a delta field', () => {
    const r = buildShadowScoreEvent(interaction());
    expect(r.row.is_shadow).toBe(true);
    // `repid_delta_calculated` is the APPLIED path in the trigger and takes
    // priority over `delta`. It is populated here for the audit trail, and it is
    // `is_shadow` alone that stops it being applied.
    expect(r.row.repid_delta_calculated).toBe(r.row.delta);
  });

  it('leaves repid_before / repid_after for the trigger that already knows them', () => {
    const r = buildShadowScoreEvent(interaction());
    expect(r.row).not.toHaveProperty('repid_before');
    expect(r.row).not.toHaveProperty('repid_after');
  });

  it('can build an applied row from the same inputs, distinguished only by mode', () => {
    const shadow = buildShadowScoreEvent(interaction(), { mode: 'shadow' });
    const applied = buildShadowScoreEvent(interaction(), { mode: 'applied' });
    expect(shadow.row.is_shadow).toBe(true);
    expect(applied.row.is_shadow).toBe(false);
    expect(applied.row.delta).toBe(shadow.row.delta);
    // Different namespaces, so a shadow row and its later applied twin never
    // collide on the globally unique idempotency index.
    expect(applied.row.idempotency_key).not.toBe(shadow.row.idempotency_key);
  });
});

describe('idempotency keys', () => {
  it('are stable for the same interaction under the same policy', () => {
    const a = buildShadowScoreEvent(interaction(), { policyVersion: 'pol1-aaaaaaaaaaaaaaaa' });
    const b = buildShadowScoreEvent(interaction(), { policyVersion: 'pol1-aaaaaaaaaaaaaaaa' });
    expect(a.row.idempotency_key).toBe(b.row.idempotency_key);
  });

  /**
   * THE LOAD-BEARING ONE. `idempotency_key` carries a global partial unique
   * index. If the key did not vary with the policy, an interaction could be
   * shadow-scored exactly once ever — so the first re-tuning run over existing
   * history would collide on every row, and re-scoring under a new policy, the
   * entire reason shadow mode exists, would be structurally impossible.
   */
  it('differ across policy versions, so history can be re-scored under a tuned policy', () => {
    const before = buildShadowScoreEvent(interaction(), { policyVersion: 'pol1-aaaaaaaaaaaaaaaa' });
    const after = buildShadowScoreEvent(interaction(), { policyVersion: 'pol1-bbbbbbbbbbbbbbbb' });
    expect(before.row.idempotency_key).not.toBe(after.row.idempotency_key);
  });

  it('differ across interactions', () => {
    const a = buildShadowScoreEvent(interaction({ interactionId: 'fabricated-a' }));
    const b = buildShadowScoreEvent(interaction({ interactionId: 'fabricated-b' }));
    expect(a.row.idempotency_key).not.toBe(b.row.idempotency_key);
  });

  it('do not mirror the settlement hash a relying party keys on', () => {
    const key = shadowIdempotencyKey(PROOF_HASH, 'pol1-aaaaaaaaaaaaaaaa');
    expect(key).not.toContain(PROOF_HASH);
    expect(key).not.toContain(PROOF_HASH.slice(2, 20));
  });

  it('refuse an empty interaction id rather than minting one key for every row', () => {
    expect(() => shadowIdempotencyKey('   ', 'pol1-aaaaaaaaaaaaaaaa')).toThrow(/interactionId is required/);
  });

  it('never collide with the peer-verification key namespace', () => {
    const key = buildShadowScoreEvent(interaction()).row.idempotency_key;
    expect(key.startsWith('peer_verify:')).toBe(false);
  });

  it('are always present — an unkeyed event on this path fails its whole insert', () => {
    const r = buildShadowScoreEvent(interaction());
    expect(typeof r.row.idempotency_key).toBe('string');
    expect(r.row.idempotency_key.length).toBeGreaterThan(0);
  });
});

describe('all three parties are recorded from the first row', () => {
  it('writes provider, consumer and builder even though only the provider is scored', () => {
    const r = buildShadowScoreEvent(interaction());
    expect(r.row.agent_id).toBe(PROVIDER);
    expect(r.row.counterparty_agent_id).toBe(CONSUMER);
    expect(r.row.builder_id).toBe(BUILDER);
    expect(r.row.contract_id).toBe(CONTRACT);
    expect(r.row.metadata['parties']).toMatchObject({
      provider_agent_id: PROVIDER,
      consumer_agent_id: CONSUMER,
      builder_id: BUILDER,
      scored: ['provider_agent_id'],
    });
  });

  it('never sets the counterparty to the provider — the table forbids it', () => {
    const r = buildShadowScoreEvent(interaction({ consumerAgentId: null }));
    expect(r.row.counterparty_agent_id).toBeNull();
    expect(r.row.counterparty_agent_id).not.toBe(r.row.agent_id);
  });
});

describe('event_type stays inside the whitelist the CHECK constraint enforces', () => {
  /**
   * Copied from `repid_score_events_event_type_check` as read from the live
   * database on 2026-08-21. The constraint is managed outside this repository,
   * so this list is a SNAPSHOT: if the constraint gains or loses a value, this
   * test does not notice. What it does catch is this module drifting to a value
   * that was never in it — which is the failure that reaches production as a
   * 23514 on every insert.
   */
  const WHITELIST_SNAPSHOT_2026_08_21 = new Set([
    'CHALLENGE_WIN', 'CHALLENGE_LOSS', 'CHALLENGE_DRAW', 'EPISTEMIC_VIOLATION',
    'CONSTITUTIONAL_VIOLATION', 'PREDICTION_RESOLVE', 'STAKE', 'GENESIS', 'REFERRAL',
    'PEACEMAKER', 'SELF_MONITOR', 'DECAY', 'DORMANCY_DECAY', 'SALE_DROP',
    'MIRROR_TEST_MODE7', 'CONSTITUTIONAL_PASS', 'CODE_CONTRIBUTION',
    'WORKFLOW_CONTRIBUTION', 'TOOL_PIONEER', 'AGENT_TEACHING', 'AUDIT_CONTRIBUTION',
    'CONSTITUTIONAL_AUDIT', 'MCP_TOOL_CALL', 'LATENCY_OPPORTUNITY_LEARNING',
    'BOUNTY_CLAIM', 'BOUNTY_COMPLETE', 'BOUNTY_VERIFY', 'HAL_SCORE_EVENT',
    'PAPER_TRADE_OUTCOME', 'VALIDATION_PASSED', 'VALIDATION_FAILED',
    'VALIDATOR_REWARD', 'VALIDATOR_PENALTY', 'SERVICE_FULFILLED',
    'SERVICE_SATISFIED', 'x402_value_delivered',
  ]);

  it('maps every outcome class to an accepted value', () => {
    for (const cls of Object.values(OutcomeClass)) {
      expect(WHITELIST_SNAPSHOT_2026_08_21.has(EVENT_TYPE_BY_OUTCOME[cls])).toBe(true);
    }
  });

  it('never files a failure as a delivery', () => {
    const delivered = 'x402_value_delivered';
    expect(EVENT_TYPE_BY_OUTCOME[OutcomeClass.FAILURE_AGENT_FAULT]).not.toBe(delivered);
    expect(EVENT_TYPE_BY_OUTCOME[OutcomeClass.FAILURE_COUNTERPARTY]).not.toBe(delivered);
    expect(EVENT_TYPE_BY_OUTCOME[OutcomeClass.FAILURE_INFRA]).not.toBe(delivered);
    expect(EVENT_TYPE_BY_OUTCOME[OutcomeClass.UNCERTAIN]).not.toBe(delivered);
  });

  it('keeps the exact class in decision_outcome, since event_type cannot express it', () => {
    const r = buildShadowScoreEvent(
      interaction({ outcomeClass: OutcomeClass.FAILURE_INFRA, halCalibratedConfidence: 0.2 }),
    );
    // Two classes share this event_type; only decision_outcome distinguishes them.
    expect(r.row.event_type).toBe(EVENT_TYPE_BY_OUTCOME[OutcomeClass.FAILURE_COUNTERPARTY]);
    expect(r.row.decision_outcome).toBe(OutcomeClass.FAILURE_INFRA);
  });

  it('files the event under the EFFECTIVE class after a demotion, not the claimed one', () => {
    // A high-value success with no anchor is demoted to UNCERTAIN by `deltaFor`.
    const r = buildShadowScoreEvent(
      interaction({ outcomeClass: OutcomeClass.SUCCESS_AUDITED, paymentProof: null, serviceValueUsdc: 500 }),
    );
    expect(r.row.decision_outcome).toBe(OutcomeClass.UNCERTAIN);
    expect(r.row.event_type).toBe(EVENT_TYPE_BY_OUTCOME[OutcomeClass.UNCERTAIN]);
    expect(r.row.metadata['claimed_outcome_class']).toBe(OutcomeClass.SUCCESS_AUDITED);
    expect(r.row.metadata['demotion_reason']).toEqual(expect.stringContaining('no linked x402 payment proof'));
  });
});

describe('the row carries what a replay needs', () => {
  it('stamps the policy version, risk band, stake and service value', () => {
    const r = buildShadowScoreEvent(interaction(), { policyVersion: 'pol1-aaaaaaaaaaaaaaaa' });
    expect(r.row.policy_version).toBe('pol1-aaaaaaaaaaaaaaaa');
    expect(r.row.risk_tier).toBe(r.risk.band);
    expect(r.row.stake_at_event).toBe(400);
    expect(r.row.economic_impact_usdc).toBe(250);
    expect(r.row.metadata['schema']).toBe(SHADOW_EVENT_SCHEMA);
  });

  it('bands on value at risk, so a large stake behind a small service is not scored as small', () => {
    const r = buildShadowScoreEvent(
      interaction({ serviceValueUsdc: 5, stakeExposedUsdc: 4000, priorInteractions: 500 }),
    );
    expect(r.risk.valueAtRisk).toBe(4000);
    expect(r.row.risk_tier).toBe(RiskBand.ATTESTED);
  });

  it('reports an unknown pair history as NOT_CHECKED in the stored row', () => {
    const r = buildShadowScoreEvent(interaction({ priorInteractions: null }));
    expect((r.row.metadata['risk'] as Record<string, unknown>)['novelty_evidence']).toBe('NOT_CHECKED');
  });

  it('carries the settlement reference only, never an asserted amount', () => {
    const r = buildShadowScoreEvent(interaction());
    const payment = r.row.metadata['payment'] as Record<string, unknown>;
    expect(payment['tx_hash']).toBe(PROOF_HASH);
    expect(payment['observed_on_chain']).toBe(true);
    expect(Object.keys(payment)).not.toContain('amount');
  });

  it('strips a malformed proof and records why, rather than passing a truthy non-hash through', () => {
    const r = buildShadowScoreEvent(
      interaction({ paymentProof: { txHash: 'pending', chainId: 84532, verified: true } }),
    );
    expect(r.anchored).toBe(false);
    const payment = r.row.metadata['payment'] as Record<string, unknown>;
    expect(payment['tx_hash']).toBeNull();
    expect(payment['rejected']).toMatchObject({ error: 'malformed_hash' });
  });

  it('clamps stored certainty into the range the column will accept', () => {
    expect(buildShadowScoreEvent(interaction({ halCalibratedConfidence: 4 })).row.certainty_at_claim).toBe(1);
    expect(buildShadowScoreEvent(interaction({ halCalibratedConfidence: -2 })).row.certainty_at_claim).toBe(0);
  });

  it('is deterministic — the same interaction and policy produce the same row', () => {
    const a = buildShadowScoreEvent(interaction(), { policyVersion: 'pol1-aaaaaaaaaaaaaaaa' });
    const b = buildShadowScoreEvent(interaction(), { policyVersion: 'pol1-aaaaaaaaaaaaaaaa' });
    expect(JSON.stringify(a.row)).toBe(JSON.stringify(b.row));
  });
});
