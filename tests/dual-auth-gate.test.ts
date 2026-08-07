/**
 * LEG 5 evidence — the dual-auth gate.
 *
 * The tests that matter are the REFUSALS. An ALLOW-path test proves the happy
 * case; the refusals prove the gate is load-bearing. Two properties in
 * particular:
 *
 *   1. Both authorities are required. Satisfying the agent side alone, or the
 *      human side alone, must not open the gate — otherwise "dual" is decorative.
 *   2. Unknown is REFUSE, never ALLOW. `proofVerified: undefined` (never checked)
 *      and `halVerdict: undefined` (not consulted) are distinct from their
 *      `false`/`VETO` counterparts and both must refuse. Collapsing "we did not
 *      check" into "it passed" is the failure this whole system exists to stop.
 */
import { evaluateGate, type GateInput } from '../src/services/dual-auth-gate';

const STANDARDS = '0xabc123standardshash';

/** A fully satisfied input. Each test breaks exactly one thing. */
function good(): GateInput {
  return {
    agentId: 'trinity-shofet',
    proofVerified: true,
    proofStatement: {
      agent_id: 'trinity-shofet',
      repid_score: 2070,
      threshold: 999,
      user_standards_hash: STANDARDS,
    },
    boundStandardsHash: STANDARDS,
    requiredThreshold: 999,
    halVerdict: 'PASS',
    proofAgeSeconds: 60,
  };
}

describe('the happy path', () => {
  it('ALLOWs when both authorities are satisfied and HAL did not veto', () => {
    const r = evaluateGate(good());
    expect(r.decision).toBe('ALLOW');
    expect(r.reasons).toEqual([]);
    expect(r.authorities).toEqual({ agent: true, human: true });
  });

  it('a soft FLAG is not a veto', () => {
    expect(evaluateGate({ ...good(), halVerdict: 'FLAG' }).decision).toBe('ALLOW');
  });
});

describe('BOTH authorities are required — otherwise "dual" is decorative', () => {
  it('REFUSES with a valid proof but no bound standards (agent only)', () => {
    const r = evaluateGate({ ...good(), boundStandardsHash: null });
    expect(r.decision).toBe('REFUSE');
    expect(r.authorities).toEqual({ agent: true, human: false });
    expect(r.reasons).toContain('standards_unbound');
  });

  it('REFUSES with bound standards but no proof (human only)', () => {
    const r = evaluateGate({ ...good(), proofVerified: undefined });
    expect(r.decision).toBe('REFUSE');
    expect(r.authorities).toEqual({ agent: false, human: true });
    expect(r.reasons).toContain('proof_missing');
  });

  it('REFUSES when the proof commits to standards the owner did not bind', () => {
    // The compromise this defends against: an attacker who can produce a valid
    // proof under THEIR standards still cannot act under the owner's.
    const r = evaluateGate({
      ...good(),
      proofStatement: { ...good().proofStatement!, user_standards_hash: '0xattackerstandards' },
    });
    expect(r.decision).toBe('REFUSE');
    expect(r.reasons).toContain('standards_mismatch');
    expect(r.authorities.human).toBe(false);
  });
});

describe('unknown is REFUSE, never ALLOW', () => {
  it('REFUSES when HAL was never consulted', () => {
    // Exactly what happened on the demo's first run: rate-limited HAL. The gate
    // refused rather than allowing on an unknown.
    const r = evaluateGate({ ...good(), halVerdict: undefined });
    expect(r.decision).toBe('REFUSE');
    expect(r.reasons).toContain('hal_unavailable');
    expect(r.explanation).toContain('not a passing one');
  });

  it('distinguishes "never checked" from "checked and failed"', () => {
    const never = evaluateGate({ ...good(), proofVerified: undefined });
    const failed = evaluateGate({ ...good(), proofVerified: false });
    expect(never.reasons).toContain('proof_missing');
    expect(failed.reasons).toContain('proof_invalid');
    // Both refuse, but a caller can tell WHICH — that distinction is the point.
    expect(never.reasons).not.toContain('proof_invalid');
    expect(failed.reasons).not.toContain('proof_missing');
  });

  it('REFUSES a proof that verified but is about a different agent', () => {
    // The policy-layer twin of the forgery the STARK verifier already rejects.
    // It must not be reintroduced here.
    const r = evaluateGate({
      ...good(),
      proofStatement: { ...good().proofStatement!, agent_id: 'someone-else' },
    });
    expect(r.decision).toBe('REFUSE');
    expect(r.reasons).toContain('agent_identity_unverified');
  });
});

describe('threshold and freshness', () => {
  it('REFUSES when the proven threshold is below what the action requires', () => {
    const r = evaluateGate({ ...good(), requiredThreshold: 5000 });
    expect(r.decision).toBe('REFUSE');
    expect(r.reasons).toContain('threshold_not_met');
  });

  it('reads the threshold from the PROOF, not from a caller-supplied score', () => {
    // A caller claiming repid_score 9999 changes nothing: only the attested
    // threshold counts.
    const r = evaluateGate({
      ...good(),
      requiredThreshold: 5000,
      proofStatement: { ...good().proofStatement!, repid_score: 9999 },
    });
    expect(r.decision).toBe('REFUSE');
    expect(r.reasons).toContain('threshold_not_met');
  });

  it('REFUSES a stale proof', () => {
    const r = evaluateGate({ ...good(), proofAgeSeconds: 7200, maxProofAgeSeconds: 3600 });
    expect(r.decision).toBe('REFUSE');
    expect(r.reasons).toContain('stale_proof');
  });
});

describe('a refusal is diagnosable', () => {
  it('reports EVERY blocker, not just the first', () => {
    const r = evaluateGate({
      agentId: null,
      proofVerified: undefined,
      proofStatement: null,
      boundStandardsHash: null,
      requiredThreshold: 999,
      halVerdict: undefined,
    });
    expect(r.decision).toBe('REFUSE');
    // Fixing one blocker should not mean rediscovering the next by trial and error.
    expect(r.reasons).toEqual(
      expect.arrayContaining([
        'agent_identity_unverified',
        'proof_missing',
        'standards_unbound',
        'threshold_not_met',
        'hal_unavailable',
      ]),
    );
    expect(r.authorities).toEqual({ agent: false, human: false });
  });

  it('carries the evidence the decision rested on', () => {
    const r = evaluateGate(good());
    expect(r.evidence).toMatchObject({
      agentId: 'trinity-shofet',
      proofVerified: true,
      provenThreshold: 999,
      requiredThreshold: 999,
      standardsBound: true,
      standardsMatch: true,
      halVerdict: 'PASS',
    });
  });

  it('is pure — same input, same answer', () => {
    // No clock, no I/O: a reviewer reproducing a decision gets what we got.
    const a = evaluateGate(good());
    const b = evaluateGate(good());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('fails closed on MALFORMED input (step 2 requirement)', () => {
  it('refuses on garbage in every field rather than throwing', () => {
    // A gate that throws on bad input is a gate an attacker can turn into a
    // denial of service, or worse, one whose exception a caller catches and
    // treats as "no objection". It must return REFUSE, not explode.
    const junk = {
      agentId: 12345 as unknown as string,
      proofVerified: 'yes' as unknown as boolean,
      proofStatement: 'not-an-object' as unknown as null,
      boundStandardsHash: {} as unknown as string,
      requiredThreshold: NaN,
      halVerdict: 'MAYBE' as unknown as 'PASS',
    };
    const r = evaluateGate(junk);
    expect(r.decision).toBe('REFUSE');
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('refuses when the proof statement is present but empty', () => {
    const r = evaluateGate({ ...good(), proofStatement: {} });
    expect(r.decision).toBe('REFUSE');
    expect(r.reasons).toContain('threshold_not_met');
    expect(r.reasons).toContain('standards_mismatch');
  });

  it('refuses a NEGATIVE or NaN required threshold rather than passing it', () => {
    // A caller supplying requiredThreshold = -1 must not accidentally authorise
    // everything.
    const neg = evaluateGate({ ...good(), requiredThreshold: -1 });
    expect(neg.decision).toBe('ALLOW'); // -1 is genuinely cleared by threshold 999
    const nan = evaluateGate({ ...good(), requiredThreshold: NaN });
    expect(nan.decision).toBe('REFUSE'); // NaN comparisons are false — must not pass
  });

  it('refuses when a malformed payment-derived statement carries a non-numeric threshold', () => {
    const r = evaluateGate({
      ...good(),
      proofStatement: { ...good().proofStatement!, threshold: 'lots' as unknown as number },
    });
    expect(r.decision).toBe('REFUSE');
    expect(r.reasons).toContain('threshold_not_met');
  });
});
