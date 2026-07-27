/**
 * HAL grounding / abstain primitive (shadow-first). Uses real P2 proof-carrying answers.
 * Verdict effect is pipeline-level + enforce-gated; this tests the SIGNAL (pure).
 */
import { groundingMode, computeGroundingSignal } from '../src/hal/hal-grounding';
import { ProofCarryingMemory, bindAnswer, emitGroundedAnswer } from '../src/memory/proof-carrying-memory';

function groundedPCA() {
  const mem = new ProofCarryingMemory();
  const v = mem.add({ content: 'a fact', source_id: 'a', source_repid: 1200, hal_verdict: 'clean', epoch: 1 });
  return emitGroundedAnswer('answer citing the fact', mem, [v]);
}

describe('groundingMode — env resolution (default shadow)', () => {
  it('resolves off / shadow / enforce and defaults to shadow', () => {
    expect(groundingMode('off')).toBe('off');
    expect(groundingMode('shadow')).toBe('shadow');
    expect(groundingMode('ENFORCE')).toBe('enforce');
    expect(groundingMode(undefined)).toBe('shadow');
    expect(groundingMode('')).toBe('shadow');
    expect(groundingMode('garbage')).toBe('shadow');
  });
});

describe('computeGroundingSignal', () => {
  it('no proof-carrying answer → not applicable, never abstains (byte-identical path)', () => {
    const s = computeGroundingSignal({}, 'shadow');
    expect(s.applicable).toBe(false);
    expect(s.would_abstain).toBe(false);
    expect(s.reason).toBe('no_proof_carrying_answer');
  });

  it("mode 'off' with a PCA → applicable but not computed, no abstain", () => {
    const s = computeGroundingSignal({ proof_carrying_answer: groundedPCA() }, 'off');
    expect(s.applicable).toBe(true);
    expect(s.grounded).toBe(false);
    expect(s.would_abstain).toBe(false);
    expect(s.reason).toBe('not_computed(mode_off)');
  });

  it('shadow + a grounded PCA → grounded, would NOT abstain', () => {
    const s = computeGroundingSignal({ proof_carrying_answer: groundedPCA() }, 'shadow');
    expect(s.applicable).toBe(true);
    expect(s.grounded).toBe(true);
    expect(s.would_abstain).toBe(false);
    expect(s.verified_citations).toBe(1);
  });

  it('shadow + an ungrounded (tampered) PCA → not grounded, would_abstain true', () => {
    const good = groundedPCA();
    const forged = { ...good, answer: 'a different, unsupported claim' }; // breaks the binding
    const s = computeGroundingSignal({ proof_carrying_answer: forged }, 'shadow');
    expect(s.grounded).toBe(false);
    expect(s.would_abstain).toBe(true);
    expect(s.reason).toMatch(/ungrounded/);
  });

  it('enforce + ungrounded → would_abstain true (the signal that neutralizes the delta in the pipeline)', () => {
    const good = groundedPCA();
    const forged = { ...good, citations: [] }; // no citations → not grounded
    const s = computeGroundingSignal({ proof_carrying_answer: bindAnswer(forged.answer, [], forged.memory_root) }, 'enforce');
    expect(s.mode).toBe('enforce');
    expect(s.would_abstain).toBe(true);
  });
});
