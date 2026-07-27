/**
 * P2 — proof-carrying retrieval + answer-binding (Patent #1 keystone), under real Poseidon2.
 * Proves: retrieval carries verifying proofs; an answer binds to its cited proof-set;
 * tampering (answer or citation) breaks grounding; revoking a cited entry makes it
 * un-retrievable and its stale citation un-verifiable; and the abstain path refuses
 * to emit an ungrounded answer.
 */
import {
  ProofCarryingMemory, bindAnswer, verifyProofCarryingAnswer, emitGroundedAnswer,
  type MemoryEntry,
} from '../src/memory/proof-carrying-memory';

function entry(content: string, repid = 1200, verdict = 'clean'): MemoryEntry {
  return { content, source_id: 'agent-x', source_repid: repid, hal_verdict: verdict, epoch: 1 };
}

describe('ProofCarryingMemory — retrieval carries verifying proofs', () => {
  const mem = new ProofCarryingMemory();
  const vSky = mem.add(entry('the sky is blue'));
  mem.add(entry('water boils at 100C at 1atm'));
  mem.add(entry('the earth orbits the sun'));

  it('every retrieved entry carries an inclusion proof that verifies against the root', () => {
    const hits = mem.retrieve((e) => e.content.includes('sky') || e.content.includes('orbits'));
    expect(hits.length).toBe(2);
    const pca = bindAnswer('answer', hits.map((h) => ({ content: h.entry.content, value: h.value, witness: h.witness })), mem.root());
    const v = verifyProofCarryingAnswer(pca);
    expect(v.verified_citations).toBe(2);
  });

  it('add is idempotent (same content → same value)', () => {
    expect(mem.add(entry('the sky is blue'))).toBe(vSky);
  });
});

describe('ProofCarryingMemory — answer-binding roundtrip + tamper detection', () => {
  const mem = new ProofCarryingMemory();
  const v1 = mem.add(entry('fact one'));
  const v2 = mem.add(entry('fact two'));

  it('a grounded answer binds and verifies', () => {
    const pca = emitGroundedAnswer('grounded in one and two', mem, [v1, v2]);
    const v = verifyProofCarryingAnswer(pca);
    expect(v.grounded).toBe(true);
    expect(v.binding_ok).toBe(true);
    expect(v.verified_citations).toBe(2);
  });

  it('tampering the answer breaks the binding (not grounded)', () => {
    const pca = emitGroundedAnswer('original', mem, [v1]);
    const forged = { ...pca, answer: 'a different claim' };
    const v = verifyProofCarryingAnswer(forged);
    expect(v.binding_ok).toBe(false);
    expect(v.grounded).toBe(false);
  });

  it('tampering a citation witness fails that citation (not grounded)', () => {
    const good = emitGroundedAnswer('cites two facts', mem, [v1, v2]);
    // swap in a corrupted proof path on the first citation, then re-bind so the binding matches the tamper
    const wrongSibling = '0x' + '11'.repeat(32); // valid 64-hex, but not the real sibling
    const badCitations = good.citations.map((c, i) =>
      i === 0 ? { ...c, witness: { ...c.witness, path: [{ sibling: wrongSibling, siblingOnLeft: false }] } } : c);
    const rebound = bindAnswer(good.answer, badCitations, good.memory_root);
    const v = verifyProofCarryingAnswer(rebound);
    expect(v.grounded).toBe(false);
    expect(v.verified_citations).toBeLessThan(v.total_citations);
  });

  it('is adversarial-input safe: a malformed (garbage-hex) witness yields not-grounded, never throws', () => {
    const good = emitGroundedAnswer('one fact', mem, [v1]);
    const garbage = good.citations.map((c) => ({ ...c, witness: { ...c.witness, path: [{ sibling: '0xzz', siblingOnLeft: false }] } }));
    const rebound = bindAnswer(good.answer, garbage, good.memory_root);
    let v: ReturnType<typeof verifyProofCarryingAnswer> | undefined;
    expect(() => { v = verifyProofCarryingAnswer(rebound); }).not.toThrow();
    expect(v!.grounded).toBe(false);
  });
});

describe('ProofCarryingMemory — provable retraction + abstain', () => {
  it('revoking a cited entry: excluded from retrieval, and a stale citation no longer verifies', () => {
    const mem = new ProofCarryingMemory();
    const vA = mem.add(entry('later-falsified claim'));
    mem.add(entry('durable claim'));
    const stale = emitGroundedAnswer('relies on A', mem, [vA]); // grounded at the pre-revoke root
    expect(verifyProofCarryingAnswer(stale).grounded).toBe(true);

    mem.revoke(vA);
    // no longer retrievable
    expect(mem.retrieve((e) => e.content.includes('falsified')).length).toBe(0);
    // the stale proof-carrying answer no longer verifies against the NEW root
    const staleAtNewRoot = { ...stale, memory_root: mem.root() };
    expect(verifyProofCarryingAnswer(staleAtNewRoot).grounded).toBe(false);
    // and you cannot emit a fresh grounded answer citing the revoked entry → abstain
    expect(() => emitGroundedAnswer('still relies on A', mem, [vA])).toThrow(/abstain/);
  });

  it('abstains when citing a value that was never committed', () => {
    const mem = new ProofCarryingMemory();
    mem.add(entry('the only fact'));
    expect(() => emitGroundedAnswer('ungrounded', mem, ['123456789'])).toThrow(/abstain/);
  });

  it('abstains on an answer with no citations', () => {
    const mem = new ProofCarryingMemory();
    mem.add(entry('a fact'));
    expect(() => emitGroundedAnswer('no citations', mem, [])).toThrow(/abstain/);
  });

  /**
   * Regression pin. The revoked-citation path used to let the ACCUMULATOR's own error escape
   * ("LeanIMTPlus.membershipProof: value … not active"), so the one abstain case this primitive
   * exists for — provable retraction forcing abstention — was the one case NOT signalled as an
   * abstention. A caller that branches on the `abstain:` contract (which is the documented way to
   * tell a principled refusal from an internal fault) mis-classified a retraction as a bug.
   */
  it('signals EVERY abstain path with the `abstain:` contract, including a revoked citation', () => {
    const mem = new ProofCarryingMemory();
    const vRevoked = mem.add(entry('to be retracted'));
    mem.add(entry('durable claim')); // a second entry, so revoke() has a predecessor to relink
    mem.revoke(vRevoked);

    const cases: Array<[string, () => unknown]> = [
      ['no citations', () => emitGroundedAnswer('x', mem, [])],
      ['never committed', () => emitGroundedAnswer('x', mem, ['123456789'])],
      ['revoked citation', () => emitGroundedAnswer('x', mem, [vRevoked])],
    ];
    for (const [name, run] of cases) {
      let message = '';
      expect(() => { try { run(); } catch (e) { message = (e as Error).message; throw e; } }).toThrow();
      // Compared as a pair so a failure names WHICH path leaked instead of just showing a bad prefix.
      expect([name, message.slice(0, 8)]).toEqual([name, 'abstain:']);
    }
  });

  it('the revoked-citation abstention states why AND preserves the underlying cause', () => {
    const mem = new ProofCarryingMemory();
    const vRevoked = mem.add(entry('to be retracted'));
    mem.add(entry('durable claim'));
    mem.revoke(vRevoked);

    let message = '';
    try { emitGroundedAnswer('cites a retracted fact', mem, [vRevoked]); }
    catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/^abstain: /);          // the contract callers branch on
    expect(message).toMatch(/not currently valid/); // WHY it abstained, in this layer's vocabulary
    expect(message).toMatch(/not active/);          // the accumulator's cause, kept for diagnosis
  });
});
