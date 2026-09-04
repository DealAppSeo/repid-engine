/**
 * policy-gate.test.ts — invariant tests for the deterministic Policy Gate.
 *
 * The last block is the MUTANT GUARD: it fails if anyone weakens the gate so a
 * probabilistic signal (HAL) can manufacture authority the sensors/receipt did
 * not grant. That is the single regression this kernel must never suffer.
 */
import { gate, EvidenceBundle } from '../src/kernel/policy-gate';

const base = (over: Partial<EvidenceBundle> = {}): EvidenceBundle => ({
  action_class: 'durable_repid_move',
  risk_class: 1,
  proposed_delta: 5,
  settled_receipt_id: 'rcpt_1',
  hal: { mode: 'fact-check', families_used: 3, providers_succeeded: 3, decision: 'clean', hal_score: 0.2 },
  sensors: { tests_passed: true, schema_valid: true, hash_verified: true },
  repid: { n: 12, u: 0.2, lcb: 900 },
  capability: { valid: true, in_scope: true },
  purpose: { is_deliverable: true },
  budget_remaining: 1_000_000,
  ...over,
});

describe('Policy Gate — durable RepID move', () => {
  it('ALLOWs and authorizes the delta when every precondition holds', () => {
    const r = gate(base());
    expect(r.decision).toBe('ALLOW');
    expect(r.durable_move_authorized).toBe(true);
    expect(r.authorized_delta).toBe(5);
  });

  it('DENIES a durable move with no settled receipt (the core audit gap)', () => {
    const r = gate(base({ settled_receipt_id: null }));
    expect(r.decision).toBe('DENY');
    expect(r.durable_move_authorized).toBe(false);
    expect(r.authorized_delta).toBe(0);
    expect(r.reasons).toContain('no_settled_receipt');
  });

  it('holds (ASK) on the zero-evidence gate: n=0 is unknown, not average', () => {
    const r = gate(base({ repid: { n: 0, u: 1.0 } }));
    expect(r.decision).toBe('ASK');
    expect(r.durable_move_authorized).toBe(false);
    expect(r.authorized_delta).toBe(0);
  });

  it('neutralizes an UNGROUNDED penalty (no quorum, no independent validation)', () => {
    const r = gate(base({ proposed_delta: -10, hal: { mode: 'extractor-fallback', families_used: 1 } }));
    expect(r.durable_move_authorized).toBe(true);
    expect(r.authorized_delta).toBe(0);
    expect(r.reasons).toContain('penalty_neutralized:ungrounded');
  });

  it('GROUNDS a penalty on an independent validation (validator != subject)', () => {
    const r = gate(base({
      proposed_delta: -10,
      hal: { mode: 'extractor-fallback' }, // no quorum
      validation: { source: 'redteam_adjudication', validation_id: 'chal_9', validator_agent_id: 'finder', subject_agent_id: 'subject' },
    }));
    expect(r.authorized_delta).toBe(-10);
    expect(r.reasons).toContain('penalty_authorized:independent_validation');
  });

  it('rejects SELF-validation: a validator cannot ground a move against itself', () => {
    const r = gate(base({
      proposed_delta: -10,
      hal: { mode: 'extractor-fallback' },
      validation: { source: 'redteam_adjudication', validation_id: 'chal_9', validator_agent_id: 'same', subject_agent_id: 'same' },
    }));
    expect(r.authorized_delta).toBe(0);
    expect(r.reasons).toContain('penalty_neutralized:ungrounded');
  });

  it('GROUNDS a VALIDATOR_REWARD on an independent validation, no settlement/provider needed', () => {
    const r = gate(base({
      proposed_delta: 12,
      hal: { mode: 'extractor', providers_succeeded: 0 },
      sensors: { tests_passed: false },
      validation: { source: 'redteam_adjudication', validation_id: 'chal_9', validator_agent_id: 'finder', subject_agent_id: 'subject' },
    }));
    expect(r.authorized_delta).toBe(12);
    expect(r.reasons).toContain('reward_authorized:independent_validation');
  });

  it('neutralizes a HAL-claim REWARD with no provider evidence AND no settlement', () => {
    const r = gate(base({
      proposed_delta: 5,
      hal: { mode: 'fact-check', families_used: 2, providers_succeeded: 0 },
      sensors: { tests_passed: false }, // no settlement confirmation either
    }));
    expect(r.authorized_delta).toBe(0);
    expect(r.reasons).toContain('reward_neutralized:no_evidence');
  });

  it('authorizes an ECONOMIC settlement reward on deterministic delivery, no HAL provider needed', () => {
    const r = gate(base({
      proposed_delta: 5,
      hal: { mode: 'extractor', providers_succeeded: 0 }, // no fact-check quorum — a settlement, not a claim
      sensors: { tests_passed: true }, // delivery verified / settlement confirmed
    }));
    expect(r.authorized_delta).toBe(5);
    expect(r.reasons).toContain('reward_authorized:settlement_sensors');
  });

  it('zeroes the delta for a non-deliverable purpose in BOTH directions', () => {
    const pen = gate(base({ proposed_delta: -10, purpose: { is_deliverable: false } }));
    const rew = gate(base({ proposed_delta: 5, purpose: { is_deliverable: false } }));
    expect(pen.authorized_delta).toBe(0);
    expect(rew.authorized_delta).toBe(0);
  });

  it('DENIES on a constitution hard-layer violation, before anything else', () => {
    const r = gate(base({ constitution_violations: ['never_disable_hal'] }));
    expect(r.decision).toBe('DENY');
  });

  it('escalates a high-impact move on thin history instead of auto-applying', () => {
    const r = gate(base({ risk_class: 4, repid: { n: 1, u: 0.3 } }));
    expect(r.decision).toBe('ASK');
    expect(r.escalate_to).toBe('human');
  });
});

describe('Policy Gate — MUTANT GUARD (HAL must never manufacture authority)', () => {
  it('a maximally-confident clean HAL verdict cannot move RepID without a receipt', () => {
    const r = gate(base({
      settled_receipt_id: null,
      proposed_delta: 25,
      hal: { mode: 'fact-check', families_used: 5, providers_succeeded: 5, decision: 'clean', hal_score: 0.0 },
      sensors: { tests_passed: true, schema_valid: true, hash_verified: true, reexec_matched: true },
      repid: { n: 5000, u: 0.01, lcb: 990 },
    }));
    expect(r.durable_move_authorized).toBe(false);
    expect(r.authorized_delta).toBe(0);
    expect(r.decision).toBe('DENY');
  });

  it('a mutating action with unknown sensors fails closed, never ALLOWs silently', () => {
    const r = gate({ action_class: 'execute_mutating', risk_class: 2 });
    expect(r.decision === 'DENY' || r.decision === 'ASK').toBe(true);
    expect(r.durable_move_authorized).toBe(false);
  });
});
