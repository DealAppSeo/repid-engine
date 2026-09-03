/**
 * A proof that verifies is not the same as a claim that could have failed.
 *
 * Measured 2026-09-03: a large minority of agents holding a real proof carry a
 * threshold of 0 — every probationary one, because the threshold IS the tier floor and
 * the lowest tier's floor is zero. Scores are clamped to [10, 10000], so `score >= 0`
 * cannot be false for any valid agent. The passport reported
 * `cryptographically_verifiable: true` and did not include the threshold at all, so
 * there was no way for a reader to tell a cleared bar from one nothing could trip on.
 *
 * The tests below pin both halves, because stating either alone is a different
 * falsehood: a vacuous threshold does NOT mean a broken proof — the proof still binds
 * agent_id to an exact score tamper-evidently — and a verifying proof does NOT mean a
 * meaningful threshold was met.
 */
import { describe, it, expect } from '@jest/globals';
import { proofClaim, classifyThreshold, CLAIM_NOTES } from '../src/services/proof-claim';
import { REPID_MIN } from '../src/scoring/repid-clamp';

describe('classifyThreshold', () => {
  it('calls a threshold no valid score can fail VACUOUS', () => {
    expect(classifyThreshold(0)).toBe('VACUOUS');
    // The bound is the CLAMP FLOOR, not zero. `score >= 10` is exactly as
    // unfalsifiable as `score >= 0` when 10 is the minimum possible score, and a rule
    // anchored on 0 would call it BINDING — right answer, wrong reason, and wrong the
    // moment a tier floor lands between 1 and 10.
    expect(classifyThreshold(REPID_MIN)).toBe('VACUOUS');
    expect(classifyThreshold(REPID_MIN - 1)).toBe('VACUOUS');
  });

  it('calls a threshold a real score could fail BINDING', () => {
    expect(classifyThreshold(REPID_MIN + 1)).toBe('BINDING');
    expect(classifyThreshold(999)).toBe('BINDING');
    expect(classifyThreshold(10_000)).toBe('BINDING');
  });

  it('is UNKNOWN when no threshold is recorded — not assumed either way', () => {
    expect(classifyThreshold(null)).toBe('UNKNOWN');
    expect(classifyThreshold(undefined)).toBe('UNKNOWN');
    expect(classifyThreshold(NaN)).toBe('UNKNOWN');
  });
});

describe('proofClaim', () => {
  it('reads the threshold out of the statement and renders the claim in words', () => {
    const c = proofClaim({ threshold: 999, repid_score: 1772, tier: 'ESTABLISHED' });
    expect(c.threshold).toBe(999);
    expect(c.statement).toBe('score >= 999');
    expect(c.claim).toBe('BINDING');
  });

  it('flags the new-agent case, which is the one that motivated this', () => {
    const c = proofClaim({ threshold: 0, repid_score: 200, tier: 'PROBATIONARY' });
    expect(c.claim).toBe('VACUOUS');
    expect(c.statement).toBe('score >= 0');
  });

  it('survives a missing, malformed or absent statement without inventing a claim', () => {
    for (const s of [null, undefined, {}, 'not-an-object', 42, { threshold: 'abc' }]) {
      const c = proofClaim(s);
      expect(c.claim).toBe('UNKNOWN');
      expect(c.threshold).toBeNull();
      expect(c.statement).toBeNull();
    }
  });
});

describe('the notes say BOTH things', () => {
  it('VACUOUS says the threshold establishes nothing AND that the proof still binds', () => {
    const n = CLAIM_NOTES.VACUOUS.toLowerCase();
    expect(n).toMatch(/every valid score|no score could have failed/);
    // …and must NOT read as "this proof is worthless".
    expect(n).toMatch(/tamper-evidence|binding this agent/);
    expect(n).not.toMatch(/invalid|broken|fake/);
  });

  it('BINDING says a lower score would actually have failed', () => {
    expect(CLAIM_NOTES.BINDING.toLowerCase()).toMatch(/would fail/);
  });

  it('UNKNOWN asserts nothing in either direction', () => {
    const n = CLAIM_NOTES.UNKNOWN.toLowerCase();
    expect(n).toMatch(/cannot say|not asserted/);
  });

  it('every state has a distinct, substantial note', () => {
    const notes = Object.values(CLAIM_NOTES);
    expect(new Set(notes).size).toBe(notes.length);
    for (const n of notes) expect(n.length).toBeGreaterThan(40);
  });
});
