/**
 * answer-binding-pins.test.ts — pins for the Patent #1 keystone (ANSWER-BINDING) and for the
 * verifier's documented adversarial-input contract.
 *
 * WHY THIS FILE EXISTS (Beat 47's independent verification of PR #220, two HIGH findings):
 *
 *  1. The answer-binding element — the Patent #1 keystone by `proof-carrying-memory.ts`'s own
 *     header — was ENTIRELY UNPINNED. Three mutations that REDUCED what `bindAnswer` commits to
 *     (dropping the root, dropping the citations, dropping the answer) each survived the whole
 *     47-test Patent #1 battery. The shipped code was correct; nothing proved it. For
 *     reduction-to-practice material the test IS the evidence, so each component of the binding
 *     gets its own killing test here.
 *
 *  2. `verifyProofCarryingAnswer` documents itself "Adversarial-input safe … it never crashes the
 *     verifier", and `computeGroundingSignal` documents "Never throws". Both were false: the
 *     binding recomputation sat OUTSIDE the try/catch, so a malformed `memory_root` threw out of
 *     the verifier — on the exact path HAL uses to check UNTRUSTED agent output, with
 *     `HAL_GROUNDING_MODE=enforce` a planned flip.
 *
 * These are pure unit tests: real Poseidon2 (module defaults), no network, no DB, no mocks.
 */
import {
  ProofCarryingMemory, bindAnswer, verifyProofCarryingAnswer, emitGroundedAnswer,
  type MemoryEntry, type ProofCarryingAnswer, type Citation,
} from '../src/memory/proof-carrying-memory';
import { computeGroundingSignal } from '../src/hal/hal-grounding';

const entry = (content: string, epoch = 1): MemoryEntry => ({
  content, source_id: 'agent://pin-test', source_repid: 1200, hal_verdict: 'clean', epoch,
});

/** A real, fully-grounded proof-carrying answer over two committed entries. */
function fixture(): { pca: ProofCarryingAnswer; mem: ProofCarryingMemory; values: string[] } {
  const mem = new ProofCarryingMemory();
  const a = mem.add(entry('the 2019 guideline recommended X'));
  const b = mem.add(entry('the 2021 revision narrowed X to subgroup Y'));
  const pca = emitGroundedAnswer('X applies only to subgroup Y.', mem, [a, b]);
  return { pca, mem, values: [a, b] };
}

describe('answer-binding commits to every component (Patent #1 keystone)', () => {
  it('baseline: the fixture is grounded and its binding verifies', () => {
    const { pca } = fixture();
    const v = verifyProofCarryingAnswer(pca);
    expect(v.binding_ok).toBe(true);
    expect(v.grounded).toBe(true);
    expect(v.verified_citations).toBe(2);
    expect(v.total_citations).toBe(2);
  });

  // Each case below FAILS if `bindAnswer` stops committing to that component — which is exactly
  // the mutation class that survived the pre-existing battery.
  it('commits to the ANSWER — changing the answer changes the binding', () => {
    const { pca } = fixture();
    const other = bindAnswer(pca.answer + '!', pca.citations, pca.memory_root);
    expect(other.binding).not.toBe(pca.binding);
  });

  it('commits to the MEMORY ROOT — changing the root changes the binding', () => {
    const { pca, mem } = fixture();
    const rootBefore = pca.memory_root;
    mem.add(entry('an unrelated later fact', 2)); // moves the root
    const rootAfter = mem.root();
    expect(rootAfter).not.toBe(rootBefore);
    const other = bindAnswer(pca.answer, pca.citations, rootAfter);
    expect(other.binding).not.toBe(pca.binding);
  });

  it('commits to CITATION CONTENT — altering cited content changes the binding', () => {
    const { pca } = fixture();
    const tampered: Citation[] = pca.citations.map((c, i) =>
      i === 0 ? { ...c, content: c.content + ' (edited)' } : c);
    expect(bindAnswer(pca.answer, tampered, pca.memory_root).binding).not.toBe(pca.binding);
  });

  it('commits to CITATION VALUE — swapping which entry is cited changes the binding', () => {
    const { pca } = fixture();
    const c0 = pca.citations[0]!, c1 = pca.citations[1]!;
    const relabelled: Citation[] = [{ ...c0, value: c1.value }, c1];
    expect(bindAnswer(pca.answer, relabelled, pca.memory_root).binding).not.toBe(pca.binding);
  });

  it('is ORDER-SENSITIVE — reordering the citation set changes the binding', () => {
    const { pca } = fixture();
    const reversed = [...pca.citations].reverse();
    expect(bindAnswer(pca.answer, reversed, pca.memory_root).binding).not.toBe(pca.binding);
  });

  it('commits to the CITATION COUNT — dropping a citation changes the binding', () => {
    const { pca } = fixture();
    expect(bindAnswer(pca.answer, [pca.citations[0]!], pca.memory_root).binding).not.toBe(pca.binding);
    expect(bindAnswer(pca.answer, [], pca.memory_root).binding).not.toBe(pca.binding);
  });

  it('the verifier REJECTS each tampering (not merely: the digest differs)', () => {
    const { pca } = fixture();
    const tamperings: ProofCarryingAnswer[] = [
      { ...pca, answer: 'X applies to everyone.' },
      { ...pca, citations: pca.citations.map((c, i) => (i === 0 ? { ...c, content: 'fabricated' } : c)) },
      { ...pca, citations: [...pca.citations].reverse() },
      { ...pca, citations: [pca.citations[0]!] },
    ];
    for (const t of tamperings) {
      const v = verifyProofCarryingAnswer(t);
      expect(v.binding_ok).toBe(false);
      expect(v.grounded).toBe(false);
      expect(v.reasons).toContain('binding_mismatch');
    }
  });
});

describe('the verifier is adversarial-input safe (documented contract, HAL ingests untrusted output)', () => {
  const malformed: Array<[string, ProofCarryingAnswer]> = [];
  const { pca } = fixture();
  malformed.push(['non-hex memory_root', { ...pca, memory_root: 'not-a-hex-root' as never }]);
  malformed.push(['empty memory_root', { ...pca, memory_root: '' as never }]);
  malformed.push(['0x-prefixed garbage root', { ...pca, memory_root: '0xZZZZ' as never }]);
  malformed.push(['null memory_root', { ...pca, memory_root: null as never }]);
  malformed.push(['citations not an array', { ...pca, citations: 'nope' as never }]);
  malformed.push(['null citations', { ...pca, citations: null as never }]);
  malformed.push(['citation with non-string value', {
    ...pca, citations: [{ ...pca.citations[0]!, value: { evil: true } as never }],
  }]);
  malformed.push(['citation with malformed witness', {
    ...pca, citations: [{ ...pca.citations[0]!, witness: { siblings: 'nope' } as never }],
  }]);
  malformed.push(['citation with missing fields', { ...pca, citations: [{} as never] }]);

  it.each(malformed)('%s → returns ungrounded, never throws', (_label, bad) => {
    let v: ReturnType<typeof verifyProofCarryingAnswer> | undefined;
    expect(() => { v = verifyProofCarryingAnswer(bad); }).not.toThrow();
    expect(v!.grounded).toBe(false);
  });

  it.each(malformed)('%s → HAL grounding signal degrades cleanly, never throws', (_label, bad) => {
    let sig: ReturnType<typeof computeGroundingSignal> | undefined;
    expect(() => { sig = computeGroundingSignal({ proof_carrying_answer: bad }, 'shadow'); }).not.toThrow();
    expect(sig!.applicable).toBe(true);
    expect(sig!.grounded).toBe(false);
    expect(sig!.would_abstain).toBe(true); // an `enforce` run must abstain on unverifiable input
  });

  it('an unverifiable binding is reported as such, and is NOT reported as a mismatch it never computed', () => {
    const v = verifyProofCarryingAnswer({ ...pca, memory_root: 'not-a-hex-root' as never });
    expect(v.binding_ok).toBe(false);
    expect(v.reasons).toContain('binding_uncomputable');
    expect(v.reasons).not.toContain('binding_mismatch');
  });
});
