/**
 * VALUE-TIER FENCE — the confused deputy closes above the stakes threshold.
 *
 * WHAT THIS GATE ACTUALLY BOUND, before this change. Human authority was bound to
 * `user_standards_hash` — the owner's POLICY. That is a third thing, and neither of the two
 * options usually debated:
 *
 *   session binding      an attacker riding an authenticated session can act freely
 *   POLICY binding       ← what this gate did: the policy is committed inside the proof and
 *                          cannot be swapped, but ANY in-policy action is authorised
 *   content binding      the owner authorised THIS payload
 *
 * The gap between the second and third is the CONFUSED DEPUTY, and it is the structural
 * vulnerability of agentic commerce. A compromised agent acting entirely within its owner's
 * standards is authorised, and the gate correctly returns ALLOW — the owner did permit that
 * class of action. Nobody is impersonated; real authority is simply re-aimed.
 *
 * WHY A TIER AND NOT ALWAYS-ON. Requiring content binding on every call would close the gap
 * and destroy the standing autonomy that makes an agent useful — a human would authorise
 * every individual action. So the binding strengthens with what is at stake, mirroring
 * `PAYMENT_PROOF_REQUIRED_ABOVE` (same value, same reasoning: above it, a claim needs an
 * anchor rather than a promise).
 */
import { evaluateGate, CONTENT_BINDING_REQUIRED_ABOVE, type GateInput } from '../src/services/dual-auth-gate';

const HASH = '0xstandards';
const ACTION = '0xaction-digest';

/** A request that ALLOWs on every pre-existing check, so the tier is the only variable. */
const clean = (over: Partial<GateInput> = {}): GateInput => ({
  agentId: 'agent-1',
  proofVerified: true,
  proofStatement: { agent_id: 'agent-1', threshold: 999, user_standards_hash: HASH },
  boundStandardsHash: HASH,
  requiredThreshold: 999,
  halVerdict: 'PASS',
  ...over,
});

describe('below the tier, policy binding is enough — autonomy is preserved', () => {
  test.each([0, 1, 5, 9.99, CONTENT_BINDING_REQUIRED_ABOVE])('value %p ALLOWs with no content hash', (v) => {
    const r = evaluateGate(clean({ actionValueUsdc: v }));
    expect(`${v}: ${r.decision} ${r.reasons.join(',')}`).toBe(`${v}: ALLOW `);
  });

  test('and it SAYS it did not check action binding', () => {
    const r = evaluateGate(clean({ actionValueUsdc: 5 }));
    expect(r.doesNotAttest.join(' ')).toMatch(/action_content_binding/);
    expect(r.evidence.contentBindingRequired).toBe(false);
  });
});

describe('above the tier, the owner must have authorised THIS payload', () => {
  const OVER = CONTENT_BINDING_REQUIRED_ABOVE + 0.01;

  test('no content hash anywhere → REFUSE', () => {
    const r = evaluateGate(clean({ actionValueUsdc: OVER }));
    expect(r.decision).toBe('REFUSE');
    expect(r.reasons).toContain('action_binding_missing');
  });

  test('caller supplies a hash but the proof commits to none → REFUSE', () => {
    // "Nothing to compare against" is a MISSING binding, never a satisfied one.
    const r = evaluateGate(clean({ actionValueUsdc: OVER, actionContentHash: ACTION }));
    expect(r.reasons).toContain('action_binding_missing');
  });

  test('the proof commits to a DIFFERENT action → REFUSE, and says so distinctly', () => {
    // This is the confused deputy caught in the act: valid agent, valid policy, wrong payload.
    const r = evaluateGate(clean({
      actionValueUsdc: OVER,
      actionContentHash: ACTION,
      proofStatement: { agent_id: 'agent-1', threshold: 999, user_standards_hash: HASH, action_content_hash: '0xsomething-else' },
    }));
    expect(r.decision).toBe('REFUSE');
    expect(r.reasons).toContain('action_binding_mismatch');
    expect(r.reasons).not.toContain('action_binding_missing');
    expect(r.explanation).toMatch(/DIFFERENT action/);
  });

  test('matching content hash → ALLOW', () => {
    const r = evaluateGate(clean({
      actionValueUsdc: OVER,
      actionContentHash: ACTION,
      proofStatement: { agent_id: 'agent-1', threshold: 999, user_standards_hash: HASH, action_content_hash: ACTION },
    }));
    expect(`${r.decision} ${r.reasons.join(',')}`).toBe('ALLOW ');
    expect(r.evidence.contentBindingSatisfied).toBe(true);
    // Nothing to disclaim: the check ran and passed.
    expect(r.doesNotAttest.join(' ')).not.toMatch(/action_content_binding/);
  });

  test('a large value with only policy binding is exactly the deputy case, and refuses', () => {
    const r = evaluateGate(clean({ actionValueUsdc: 10_000 }));
    expect(r.decision).toBe('REFUSE');
    expect(r.authorities.human).toBe(false);
    // The agent is genuinely who it says it is. That was never the problem.
    expect(r.authorities.agent).toBe(true);
  });
});

describe('action binding is HUMAN authority, not agent authority', () => {
  // It is the owner saying "this payload", not the agent proving who it is. Attributing it to
  // the agent would make the refusal undiagnosable — you would go looking at the wrong key.
  test('a missing binding marks human false and agent true', () => {
    const r = evaluateGate(clean({ actionValueUsdc: 500 }));
    expect(r.authorities).toEqual({ agent: true, human: false });
  });
});

describe('a malformed value fails CLOSED', () => {
  // The same trap the threshold check already documents: every comparison against NaN is
  // false, so an unparseable value would slip UNDER the tier and silently buy the weaker
  // check. If we cannot tell what is at stake, we assume it is a lot.
  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('value %p requires binding', (v) => {
    const r = evaluateGate(clean({ actionValueUsdc: v as number }));
    expect(r.decision).toBe('REFUSE');
    expect(r.reasons).toContain('action_binding_missing');
  });

  test('and it discloses that the value was unusable', () => {
    const r = evaluateGate(clean({ actionValueUsdc: Number.NaN }));
    expect(r.doesNotAttest.join(' ')).toMatch(/not a finite number/);
    expect(r.evidence.actionValueUsdc).toBeNull();
  });

  test('a NaN value with correct binding still ALLOWs — fail-closed, not fail-always', () => {
    const r = evaluateGate(clean({
      actionValueUsdc: Number.NaN,
      actionContentHash: ACTION,
      proofStatement: { agent_id: 'agent-1', threshold: 999, user_standards_hash: HASH, action_content_hash: ACTION },
    }));
    expect(r.decision).toBe('ALLOW');
  });
});

describe('backward compatibility: an undeclared value does not silently weaken anything', () => {
  test('omitting the value keeps the previous behaviour', () => {
    const r = evaluateGate(clean());
    expect(r.decision).toBe('ALLOW');
    expect(r.evidence.contentBindingRequired).toBe(false);
  });

  test('but the gap is NAMED — the likeliest way to get a weaker check is to forget the value', () => {
    // Without this line, a caller that never passes actionValueUsdc gets policy-only binding
    // forever and nothing ever says so. That is the "unwired mechanism becomes false
    // coverage" failure, and it is why the disclaimer is not optional.
    const r = evaluateGate(clean());
    expect(r.doesNotAttest.join(' ')).toMatch(/no action value declared/);
  });
});

describe('doesNotAttest reports what was SKIPPED, never what FAILED', () => {
  // Conflating "we looked and it was wrong" with "we never looked" is the collapse this
  // codebase refuses everywhere else (proofVerified undefined vs false, coverage UNKNOWN vs
  // NONE). A failed check belongs in `reasons`.
  test('a failed binding is a reason, not a disclaimer', () => {
    const r = evaluateGate(clean({
      actionValueUsdc: 500,
      actionContentHash: ACTION,
      proofStatement: { agent_id: 'agent-1', threshold: 999, user_standards_hash: HASH, action_content_hash: '0xother' },
    }));
    expect(r.reasons).toContain('action_binding_mismatch');
    expect(r.doesNotAttest.join(' ')).not.toMatch(/action_content_binding/);
  });

  test('a HAL flag is disclosed without refusing', () => {
    const r = evaluateGate(clean({ halVerdict: 'FLAG', actionValueUsdc: 1 }));
    expect(r.decision).toBe('ALLOW');
    expect(r.doesNotAttest.join(' ')).toMatch(/hal_clean/);
  });
});

describe('doesNotAttest has a CONSUMER — otherwise it is decoration', () => {
  // A negative-space field nothing reads is the same unwired-mechanism failure as a
  // confession table with no writer: it makes a reviewer believe coverage is communicated
  // when nothing communicates it.
  test('the harness prints it, and prints it on ALLOW too', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs');
    const path2 = require('node:path');
    const src = readFileSync(path2.resolve(__dirname, '../scripts/demo/trust-harness-e2e.mjs'), 'utf8');
    expect(src).toMatch(/gate\.doesNotAttest/);
    expect(src).toMatch(/does NOT attest to/);
    // Printing only on REFUSE would defeat the purpose: an ALLOW is the case where a
    // consumer is most likely to assume coverage it does not have.
    expect(src).toMatch(/gate\.decision === 'ALLOW'/);
  });
});

describe('the tier constant is coherent with the rest of the system', () => {
  test('it matches the payment-anchor threshold — one number, one mental model', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PAYMENT_PROOF_REQUIRED_ABOVE } = require('../src/services/outcome-classification');
    expect(CONTENT_BINDING_REQUIRED_ABOVE).toBe(PAYMENT_PROOF_REQUIRED_ABOVE);
  });

  test('it is strictly positive — a tier of 0 would require binding on everything', () => {
    expect(CONTENT_BINDING_REQUIRED_ABOVE).toBeGreaterThan(0);
  });
});
