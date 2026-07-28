/**
 * "Never throws" as a BEHAVIOUR, not a comment.
 *
 * `verifyProofCarryingAnswer` and `computeGroundingSignal` run on UNTRUSTED agent output, and both
 * document that they never throw. #240 established that contract for the binding and the membership
 * check — and reintroduced a hole on its own new line: the failure LABEL (`String(c.value)`) was
 * built OUTSIDE the try that guards the verification. A citation whose `value` is an accessor, or
 * an object with a throwing `toString`, escaped.
 *
 * That path is what `src/scoring/pipeline.ts:413` calls on every score event, and it is what a
 * planned `HAL_GROUNDING_MODE=enforce` run would depend on. Found by the Beat 49 adversarial
 * verification of #240, after #240 had merged.
 *
 * These cases are hostile object shapes, not malformed strings — the string cases were already
 * covered. Nothing here asserts a message; each asserts only that the call RETURNS, and returns the
 * conservative verdict.
 */
import { verifyProofCarryingAnswer, bindAnswer, ProofCarryingMemory, type ProofCarryingAnswer, type Citation } from '../src/memory/proof-carrying-memory';
import { computeGroundingSignal } from '../src/hal/hal-grounding';

/** A citation whose `value` throws the moment anything reads it. */
function citationWithThrowingValueAccessor(): Citation {
  const c: any = { content: 'x', witness: { index: 0, leaf: { value: 1n, next: 0n, tombstoned: false }, path: [] } };
  Object.defineProperty(c, 'value', { get() { throw new Error('boom: value accessor'); }, enumerable: true });
  return c as Citation;
}

/** A citation whose `value` is an object that throws when stringified (but is readable). */
function citationWithThrowingToString(): Citation {
  return {
    content: 'x',
    value: { toString() { throw new Error('boom: toString'); } } as unknown as string,
    witness: { index: 0, leaf: { value: 1n, next: 0n, tombstoned: false }, path: [] },
  } as Citation;
}

/** A real committed root — the hostile part must be the citation, not a malformed root. */
function realRoot(): string {
  const mem = new ProofCarryingMemory();
  mem.add({ content: 'a fact', source_id: 'a', source_repid: 1200, hal_verdict: 'clean', epoch: 1 });
  return mem.root();
}

/** Wrap a hostile citation in an otherwise well-formed answer object. */
function answerWith(...citations: Citation[]): ProofCarryingAnswer {
  const base = bindAnswer('an answer', [], realRoot());
  return { ...base, citations };
}

describe('verifyProofCarryingAnswer — hostile citation shapes', () => {
  it('a throwing `value` ACCESSOR does not escape the verifier', () => {
    const pca = answerWith(citationWithThrowingValueAccessor());
    expect(() => verifyProofCarryingAnswer(pca)).not.toThrow();

    const v = verifyProofCarryingAnswer(pca);
    expect(v.grounded).toBe(false);              // conservative: unnameable ⇒ unverified
    expect(v.verified_citations).toBe(0);
    expect(v.total_citations).toBe(1);
    expect(v.reasons.some((r) => r.startsWith('citation_unverified'))).toBe(true);
  });

  it('a throwing `toString` on `value` does not escape the verifier', () => {
    const pca = answerWith(citationWithThrowingToString());
    expect(() => verifyProofCarryingAnswer(pca)).not.toThrow();
    expect(verifyProofCarryingAnswer(pca).grounded).toBe(false);
  });

  it('the reason is still emitted for a citation that cannot be named', () => {
    const v = verifyProofCarryingAnswer(answerWith(citationWithThrowingValueAccessor()));
    // One reason per failed citation — the count must not silently drop just because the label did.
    expect(v.reasons.filter((r) => r.startsWith('citation_unverified')).length).toBe(1);
  });

  it('a well-formed citation is unaffected — the label is still the value prefix', () => {
    const good: Citation = {
      content: 'x',
      value: '123456789012345678',
      witness: { index: 0, leaf: { value: 1n, next: 0n, tombstoned: false }, path: [] },
    };
    const v = verifyProofCarryingAnswer(answerWith(good));
    expect(v.grounded).toBe(false);                                  // witness is bogus, as intended
    expect(v.reasons).toContain('citation_unverified:123456789012…'); // ...but named normally
  });
});

describe('computeGroundingSignal — the documented "Never throws" reaches the pipeline', () => {
  it('does not throw on a hostile citation, in shadow or enforce', () => {
    for (const mode of ['shadow', 'enforce'] as const) {
      const pca = answerWith(citationWithThrowingValueAccessor());
      expect(() => computeGroundingSignal({ proof_carrying_answer: pca }, mode)).not.toThrow();

      const s = computeGroundingSignal({ proof_carrying_answer: pca }, mode);
      expect(s.applicable).toBe(true);
      expect(s.grounded).toBe(false);
      expect(s.would_abstain).toBe(true);   // an answer we cannot verify earns nothing
    }
  });

  it('does not throw when a hostile citation sits alongside a healthy one', () => {
    const good: Citation = {
      content: 'x',
      value: '42',
      witness: { index: 0, leaf: { value: 42n, next: 0n, tombstoned: false }, path: [] },
    };
    const mixed = answerWith(good, citationWithThrowingValueAccessor());
    expect(() => computeGroundingSignal({ proof_carrying_answer: mixed }, 'shadow')).not.toThrow();
    expect(computeGroundingSignal({ proof_carrying_answer: mixed }, 'shadow').total_citations).toBe(2);
  });
});
