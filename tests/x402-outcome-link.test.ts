/**
 * STEP 2 evidence — payment-proof linking, and the fold root moving with it.
 *
 * The tests that matter: a malformed proof must be STRIPPED (not passed
 * through), and the resulting fold root must DIFFER from the anchored one. If
 * the root were identical, the anchor would be commitment-invisible — provable
 * only by trusting whoever reported it, which is the thing it exists to replace.
 */
import { createHash } from 'node:crypto';
import {
  linkPaymentProof,
  validateProofShape,
  requiresPaymentAnchor,
  DEFAULT_CHAIN_ID,
  type PaymentProof,
} from '../src/services/x402-outcome-link';
import {
  OutcomeClass,
  deltaFor,
  applyDelta,
  encodeDeltaForFold,
  PAYMENT_PROOF_REQUIRED_ABOVE,
  type OutcomeRecord,
} from '../src/services/outcome-classification';

const GOOD_HASH = '0x' + 'a1b2c3d4'.repeat(8); // 64 hex chars

function rec(over: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    class: OutcomeClass.SUCCESS_AUDITED,
    x402PaymentProof: null,
    halCalibratedConfidence: 0.9,
    valueAtRisk: 500,
    validationResponse: 95,
    timestamp: 1_754_000_000,
    agentId: 'trinity-shofet',
    ...over,
  };
}

function proof(over: Partial<PaymentProof> = {}): PaymentProof {
  return { txHash: GOOD_HASH, chainId: DEFAULT_CHAIN_ID, verified: true, ...over };
}

/**
 * Stand-in for the fold root: the same INPUT ORDERING the Rust circuit commits
 * to, hashed with sha256 instead of Poseidon2. This test is about whether the
 * anchor is INSIDE the committed preimage, which is a property of the layout,
 * not of the hash function. The real Poseidon2 root is exercised in the Rust
 * suite and in the live demo.
 */
function foldPreimageDigest(r: OutcomeRecord, updatedComponents: number): string {
  return createHash('sha256')
    .update(
      [
        'prevroot',
        r.x402PaymentProof ?? 'NONE',
        String(updatedComponents),
        'standardshash',
      ].join('|'),
    )
    .digest('hex');
}

describe('proof shape is validated strictly', () => {
  it('accepts a well-formed settlement hash', () => {
    expect(validateProofShape(proof()).ok).toBe(true);
  });

  it('REJECTS a placeholder string — the hole this closes', () => {
    // "pending" / "tx_123" would satisfy a naive truthy check and resolve to
    // nothing on-chain.
    for (const bad of ['pending', 'tx_123', '0x123', 'null', '0x' + 'z'.repeat(64)]) {
      const r = validateProofShape(proof({ txHash: bad }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe('malformed_hash');
    }
  });

  it('REJECTS a settlement on the wrong chain', () => {
    const r = validateProofShape(proof({ chainId: 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('wrong_chain');
  });

  it('distinguishes an UNVERIFIED hash from a verified one when asked', () => {
    // An unresolved hash is a claim, not evidence. Callers that care can demand
    // the distinction; the type never pretends the two are the same.
    expect(validateProofShape(proof({ verified: false })).ok).toBe(true);
    const strict = validateProofShape(proof({ verified: false }), { requireVerified: true });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.error).toBe('unverified');
  });

  it('treats a missing proof as missing, not malformed', () => {
    const r = validateProofShape(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('missing');
  });
});

describe('linking strips rather than passes through', () => {
  it('attaches a valid proof', () => {
    const l = linkPaymentProof(rec(), proof());
    expect(l.anchored).toBe(true);
    expect(l.record.x402PaymentProof).toBe(GOOD_HASH);
  });

  it('STRIPS a malformed proof so downstream cannot be fooled by a truthy string', () => {
    const l = linkPaymentProof(rec(), proof({ txHash: 'pending' }));
    expect(l.anchored).toBe(false);
    expect(l.record.x402PaymentProof).toBeNull();
    expect(l.rejected?.error).toBe('malformed_hash');
    // And the delta must be the same as if no proof were supplied at all —
    // never stronger.
    expect(deltaFor(l.record).delta).toBe(deltaFor(rec({ x402PaymentProof: null })).delta);
  });

  it('knows in ADVANCE whether an anchor will be required', () => {
    expect(requiresPaymentAnchor(rec({ valueAtRisk: 500 }), PAYMENT_PROOF_REQUIRED_ABOVE)).toBe(true);
    expect(requiresPaymentAnchor(rec({ valueAtRisk: 1 }), PAYMENT_PROOF_REQUIRED_ABOVE)).toBe(false);
    expect(
      requiresPaymentAnchor(rec({ class: OutcomeClass.FAILURE_AGENT_FAULT, valueAtRisk: 500 }), PAYMENT_PROOF_REQUIRED_ABOVE),
    ).toBe(false); // failures need no anchor — you cannot fake a penalty
  });
});

describe('high-value positive deltas REQUIRE the anchor', () => {
  it('anchored high-value success earns; unanchored earns nothing', () => {
    const anchored = linkPaymentProof(rec({ valueAtRisk: 500 }), proof());
    const unanchored = linkPaymentProof(rec({ valueAtRisk: 500 }), null);

    const dA = deltaFor(anchored.record);
    const dU = deltaFor(unanchored.record);

    expect(dA.delta).toBeGreaterThan(0);
    expect(dU.delta).toBe(0);
    expect(dU.effectiveClass).toBe(OutcomeClass.UNCERTAIN);
  });

  it('THE FOLD ROOT DIFFERS with and without the anchor', () => {
    // If these matched, the anchor would be invisible to the commitment — i.e.
    // provable only by trusting whoever reported it.
    const anchored = linkPaymentProof(rec({ valueAtRisk: 500 }), proof()).record;
    const unanchored = linkPaymentProof(rec({ valueAtRisk: 500 }), null).record;

    const scoreA = applyDelta(1000, deltaFor(anchored).delta);
    const scoreU = applyDelta(1000, deltaFor(unanchored).delta);

    expect(scoreA).not.toBe(scoreU); // the delta itself differs
    expect(foldPreimageDigest(anchored, scoreA)).not.toBe(foldPreimageDigest(unanchored, scoreU));
  });

  it('the root differs even when the SCORE happens to match', () => {
    // The stronger property: the proof is in the preimage, so two outcomes that
    // land on the same score still commit differently. Without this, an
    // unanchored outcome could impersonate an anchored one at equal score.
    const a = rec({ valueAtRisk: 500, x402PaymentProof: GOOD_HASH });
    const b = rec({ valueAtRisk: 500, x402PaymentProof: null });
    expect(foldPreimageDigest(a, 1234)).not.toBe(foldPreimageDigest(b, 1234));
  });

  it('encodes the resulting delta for the fold without wrapping', () => {
    const anchored = linkPaymentProof(rec({ valueAtRisk: 500 }), proof()).record;
    const enc = encodeDeltaForFold(deltaFor(anchored).delta);
    expect(enc).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(enc)).toBe(true);
  });
});

describe('failures never need an anchor', () => {
  it('an agent-fault penalty applies with no payment proof at all', () => {
    // You cannot fake a penalty against yourself, so requiring an anchor here
    // would only let an agent dodge accountability by withholding one.
    const d = deltaFor(rec({ class: OutcomeClass.FAILURE_AGENT_FAULT, valueAtRisk: 500, x402PaymentProof: null }));
    expect(d.delta).toBeLessThan(0);
    expect(d.effectiveClass).toBe(OutcomeClass.FAILURE_AGENT_FAULT);
  });
});
