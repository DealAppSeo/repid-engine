/**
 * STEP 1 evidence — the asymmetric delta rules.
 *
 * The load-bearing test is `a confident error costs more than a success earns`.
 * If that inequality ever flips, the rational strategy becomes guessing
 * confidently and often, and every other part of this system is downstream of
 * getting it wrong.
 */
import {
  OutcomeClass,
  deltaFor,
  applyDelta,
  encodeDeltaForFold,
  decodeDeltaFromFold,
  PAYMENT_PROOF_REQUIRED_ABOVE,
  type OutcomeRecord,
} from '../src/services/outcome-classification';

function rec(over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    class: OutcomeClass.SUCCESS_AUDITED,
    x402PaymentProof: '0xsettlement',
    halCalibratedConfidence: 0.9,
    valueAtRisk: 100,
    validationResponse: 95,
    timestamp: 1_754_000_000,
    agentId: 'trinity-shofet',
    ...over,
  };
}

describe('the asymmetry that prices confident hallucination', () => {
  it('a confident error costs MORE than an equivalent success earns', () => {
    // THE invariant. If this flips, guess-confidently-and-often becomes optimal.
    const success = deltaFor(rec({ class: OutcomeClass.SUCCESS_AUDITED, halCalibratedConfidence: 0.9 }));
    const confidentError = deltaFor(rec({ class: OutcomeClass.FAILURE_AGENT_FAULT, halCalibratedConfidence: 0.9 }));
    expect(success.delta).toBeGreaterThan(0);
    expect(confidentError.delta).toBeLessThan(0);
    expect(Math.abs(confidentError.delta)).toBeGreaterThan(success.delta);
  });

  it('a CONFIDENT error costs more than a HEDGED error', () => {
    const hedged = deltaFor(rec({ class: OutcomeClass.FAILURE_AGENT_FAULT, halCalibratedConfidence: 0.05 }));
    const confident = deltaFor(rec({ class: OutcomeClass.FAILURE_AGENT_FAULT, halCalibratedConfidence: 0.95 }));
    expect(Math.abs(confident.delta)).toBeGreaterThan(Math.abs(hedged.delta));
    // The gradient must be steep enough to change behaviour, not just annotate it.
    expect(Math.abs(confident.delta) / Math.abs(hedged.delta)).toBeGreaterThan(2);
  });

  it('an honest refusal earns more than ANY error at ANY confidence', () => {
    const refused = deltaFor(rec({ class: OutcomeClass.REFUSED_CORRECTLY }));
    for (const conf of [0, 0.25, 0.5, 0.75, 1]) {
      const err = deltaFor(rec({ class: OutcomeClass.FAILURE_AGENT_FAULT, halCalibratedConfidence: conf }));
      expect(refused.delta).toBeGreaterThan(err.delta);
    }
  });

  it('refusal reward is NOT scaled by value — otherwise refusing big jobs is farmable', () => {
    const small = deltaFor(rec({ class: OutcomeClass.REFUSED_CORRECTLY, valueAtRisk: 1 }));
    const huge = deltaFor(rec({ class: OutcomeClass.REFUSED_CORRECTLY, valueAtRisk: 1_000_000 }));
    expect(small.delta).toBe(huge.delta);
  });

  it('infra failure is exactly zero — penalising it would push agents to hide outages', () => {
    expect(deltaFor(rec({ class: OutcomeClass.FAILURE_INFRA })).delta).toBe(0);
  });

  it('value moves reputation SUB-linearly — one huge job cannot buy a tier', () => {
    const d1 = deltaFor(rec({ valueAtRisk: 100 })).delta;
    const d2 = deltaFor(rec({ valueAtRisk: 10_000 })).delta; // 100x the value
    expect(d2).toBeLessThan(d1 * 100);
  });
});

describe('payment proof as the anchor against manufactured success', () => {
  it('DEMOTES a high-value success with no payment proof', () => {
    const r = deltaFor(
      rec({ class: OutcomeClass.SUCCESS_AUDITED, valueAtRisk: 500, x402PaymentProof: null }),
    );
    expect(r.effectiveClass).toBe(OutcomeClass.UNCERTAIN);
    expect(r.delta).toBe(0);
    expect(r.demotionReason).toMatch(/no linked x402 payment proof/);
  });

  it('ADVERSARIAL: an unanchored SUCCESS_AUDITED never yields a strong positive', () => {
    // The step-1 adversarial requirement, stated directly.
    const anchored = deltaFor(rec({ valueAtRisk: 500, x402PaymentProof: '0xreal' }));
    const unanchored = deltaFor(rec({ valueAtRisk: 500, x402PaymentProof: null }));
    expect(anchored.delta).toBeGreaterThan(0);
    expect(unanchored.delta).toBe(0);
    expect(unanchored.delta).toBeLessThan(anchored.delta);
  });

  it('leaves LOW-value success alone — the anchor is for value, not ceremony', () => {
    const r = deltaFor(
      rec({ valueAtRisk: PAYMENT_PROOF_REQUIRED_ABOVE - 1, x402PaymentProof: null }),
    );
    expect(r.effectiveClass).toBe(OutcomeClass.SUCCESS_AUDITED);
    expect(r.delta).toBeGreaterThan(0);
  });

  it('demotes an "audited" claim carrying no Validation response and low confidence', () => {
    const r = deltaFor(rec({ validationResponse: null, halCalibratedConfidence: 0.2, valueAtRisk: 5 }));
    expect(r.effectiveClass).toBe(OutcomeClass.SUCCESS_UNAUDITED);
  });
});

describe('score application and fold encoding', () => {
  it('clamps to the canonical [10, 10000] RepID range', () => {
    expect(applyDelta(9_999, 500)).toBe(10_000);
    expect(applyDelta(12, -500)).toBe(10);
  });

  it('encodes a NEGATIVE delta without wrapping into field space', () => {
    // Wrapping a negative is the soundness hole the range-check AIR exists to
    // close. The encoding must stay non-negative.
    const enc = encodeDeltaForFold(-42.5);
    expect(enc).toBeGreaterThanOrEqual(0);
    expect(decodeDeltaFromFold(enc)).toBeCloseTo(-42.5, 5);
  });

  it('round-trips positive, zero and negative deltas', () => {
    for (const d of [-99.9, -1, 0, 1, 24.75]) {
      expect(decodeDeltaFromFold(encodeDeltaForFold(d))).toBeCloseTo(d, 5);
    }
  });

  it('REFUSES to encode a delta that would underflow, rather than wrapping', () => {
    expect(() => encodeDeltaForFold(-100_000)).toThrow(/underflows/);
  });
});

describe('auditability', () => {
  it('carries the exact basis the delta was computed from', () => {
    const r = deltaFor(rec({ valueAtRisk: 64, halCalibratedConfidence: 0.5 }));
    expect(r.basis).toMatchObject({
      claimedClass: OutcomeClass.SUCCESS_AUDITED,
      calibratedConfidence: 0.5,
      valueAtRisk: 64,
      valueFactor: 8, // sqrt(64)
      hasPaymentProof: true,
    });
  });

  it('is pure — same record, same delta', () => {
    const a = deltaFor(rec());
    const b = deltaFor(rec());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('uses ONLY the calibrated confidence, never the raw signals', () => {
    // Raw signals are carried for audit. If they ever influenced the delta, the
    // calibration step would be decorative.
    const withRaw = deltaFor(rec({ halRawSignals: { harm: 0.99, evidence: 0.01 } }));
    const withoutRaw = deltaFor(rec({ halRawSignals: undefined }));
    expect(withRaw.delta).toBe(withoutRaw.delta);
  });
});
