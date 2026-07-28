/**
 * ROOT CURRENCY — the replay that four demonstrations of "revocation ⇒ abstain" did not cover.
 *
 * Every existing demonstration of the abstain property (scripts/demo/proof-carrying-e2e.ts,
 * scripts/hal/medical-grounding-eval.ts, tests/proof-carrying-e2e.test.ts) builds its "stale"
 * answer as `{ ...pca, memory_root: currentRoot }` — a HAND SUBSTITUTION performed by the harness.
 * That object is a forgery no agent and no adversary produces: it asserts a root it has no witness
 * for, so it fails on the crypto. The real adversary is lazier — it REPLAYS the original answer,
 * unchanged, root and witness still agreeing with each other.
 *
 * Against that replay the pure verifier is, correctly, satisfied: the proof is valid *at the root
 * the answer asserts*. Current-validity is therefore not a property of the crypto alone — it is
 * established only when the verifier compares that asserted root to one it independently trusts.
 * These tests pin both halves: the check working when a trusted root is supplied, and the signal
 * refusing to claim currency when one is not.
 */
import { computeGroundingSignal } from '../src/hal/hal-grounding';
import { ProofCarryingMemory, emitGroundedAnswer, verifyProofCarryingAnswer } from '../src/memory/proof-carrying-memory';

/** Commit a fact, emit a grounded answer citing it, then revoke it. Returns the untouched answer. */
function committedThenRevoked() {
  const mem = new ProofCarryingMemory();
  const v = mem.add({ content: 'guidance G1 applies', source_id: 'src-a', source_repid: 1500, hal_verdict: 'clean', epoch: 1 });
  const pca = emitGroundedAnswer('G1 applies to this case', mem, [v]);
  const rootAtAnswer = mem.root();
  mem.revoke(v);
  return { mem, v, pca, rootAtAnswer, rootNow: mem.root() };
}

describe('root currency — the replayed pre-revocation answer', () => {
  it('the replay is internally consistent: revoking MOVES the root, and the untouched answer still verifies against its own', () => {
    const { pca, rootAtAnswer, rootNow } = committedThenRevoked();
    // The retraction is real and provable — the root moved.
    expect(rootNow).not.toBe(rootAtAnswer);
    // ...and yet the original answer, replayed byte-for-byte, is still valid evidence about the
    // superseded state. This is the verifier behaving correctly, and it is why currency is a
    // separate check rather than something the proof can supply.
    expect(pca.memory_root).toBe(rootAtAnswer);
    expect(verifyProofCarryingAnswer(pca).grounded).toBe(true);
  });

  it('NO trusted root → does not abstain, and does NOT claim currency (root_current null, reason downgraded)', () => {
    const { pca } = committedThenRevoked();
    const s = computeGroundingSignal({ proof_carrying_answer: pca }, 'shadow');

    expect(s.applicable).toBe(true);
    expect(s.grounded).toBe(true);          // true *at the asserted root* — the honest reading
    expect(s.would_abstain).toBe(false);    // a caller with no view of current memory cannot abstain
    // The load-bearing part: the signal must not let a caller mistake this for current validity.
    expect(s.root_current).toBeNull();
    expect(s.reason).toBe('grounded_at_asserted_root');
    expect(s.reason).not.toBe('grounded');
  });

  it('trusted CURRENT root → the replay is caught: abstain on stale_root', () => {
    const { pca, rootNow } = committedThenRevoked();
    const s = computeGroundingSignal({ proof_carrying_answer: pca, current_memory_root: rootNow }, 'shadow');

    expect(s.root_current).toBe(false);
    expect(s.grounded).toBe(false);
    expect(s.would_abstain).toBe(true);
    expect(s.reason).toBe('ungrounded:stale_root');
    // Not credited for citations it cannot currently support.
    expect(s.verified_citations).toBe(0);
    expect(s.total_citations).toBe(1);
  });

  it('trusted root EQUAL to the asserted root → currency established, full reason restored', () => {
    const mem = new ProofCarryingMemory();
    const v = mem.add({ content: 'still current', source_id: 'src-b', source_repid: 1500, hal_verdict: 'clean', epoch: 1 });
    const pca = emitGroundedAnswer('citing a live fact', mem, [v]);

    const s = computeGroundingSignal({ proof_carrying_answer: pca, current_memory_root: mem.root() }, 'shadow');
    expect(s.root_current).toBe(true);
    expect(s.grounded).toBe(true);
    expect(s.would_abstain).toBe(false);
    expect(s.reason).toBe('grounded');
    expect(s.verified_citations).toBe(1);
  });

  it('stale_root outranks valid crypto — a perfectly grounded answer at a superseded root still abstains', () => {
    // Memory moves for a reason UNRELATED to the cited fact (a second, different fact is added).
    // The cited fact is never revoked and the answer is flawless at its own root.
    const mem = new ProofCarryingMemory();
    const v = mem.add({ content: 'fact one', source_id: 'src-c', source_repid: 1500, hal_verdict: 'clean', epoch: 1 });
    const pca = emitGroundedAnswer('citing fact one', mem, [v]);
    expect(verifyProofCarryingAnswer(pca).grounded).toBe(true);

    mem.add({ content: 'fact two, unrelated', source_id: 'src-c', source_repid: 1500, hal_verdict: 'clean', epoch: 2 });

    const s = computeGroundingSignal({ proof_carrying_answer: pca, current_memory_root: mem.root() }, 'shadow');
    // Deliberately conservative: we cannot tell a retraction from an addition without re-deriving,
    // so an answer about a superseded memory state abstains. The agent's remedy is to re-derive
    // against the live root — where a still-valid fact succeeds and a revoked one yields no witness.
    expect(s.would_abstain).toBe(true);
    expect(s.reason).toBe('ungrounded:stale_root');

    // And the remedy actually works — this is what stops `stale_root` from being a dead end.
    const fresh = emitGroundedAnswer('citing fact one', mem, [v]);
    const s2 = computeGroundingSignal({ proof_carrying_answer: fresh, current_memory_root: mem.root() }, 'shadow');
    expect(s2.grounded).toBe(true);
    expect(s2.would_abstain).toBe(false);
    expect(s2.root_current).toBe(true);
  });

  it('re-deriving after a REVOCATION is impossible — the agent must abstain at emit time, not answer', () => {
    const { mem, v } = committedThenRevoked();
    expect(() => emitGroundedAnswer('G1 applies to this case', mem, [v])).toThrow(/abstain/);
  });

  it("enforce + replayed answer + trusted root → would_abstain true (the signal that zeroes a positive delta)", () => {
    const { pca, rootNow } = committedThenRevoked();
    const s = computeGroundingSignal({ proof_carrying_answer: pca, current_memory_root: rootNow }, 'enforce');
    expect(s.mode).toBe('enforce');
    expect(s.would_abstain).toBe(true);
    expect(s.root_current).toBe(false);
  });

  it("mode 'off' reports no currency verdict even when a trusted root is supplied (it computed nothing)", () => {
    const { pca, rootNow } = committedThenRevoked();
    const s = computeGroundingSignal({ proof_carrying_answer: pca, current_memory_root: rootNow }, 'off');
    expect(s.reason).toBe('not_computed(mode_off)');
    expect(s.would_abstain).toBe(false);
    expect(s.root_current).toBeNull();   // NOT false — nothing was checked
  });

  it('an empty-string trusted root is a value, not an absence — it must not silently mean "unchecked"', () => {
    const { pca } = committedThenRevoked();
    const s = computeGroundingSignal({ proof_carrying_answer: pca, current_memory_root: '' }, 'shadow');
    // '' is not the answer's root, so it is a mismatch. The danger this pins is `?? null` on a
    // falsy-but-present root quietly degrading an enforcing caller back to the unchecked path.
    expect(s.root_current).toBe(false);
    expect(s.would_abstain).toBe(true);
  });

  it('explicit null/undefined trusted root behaves as unchecked (callers pass through optional fields)', () => {
    const { pca } = committedThenRevoked();
    for (const root of [null, undefined]) {
      const s = computeGroundingSignal({ proof_carrying_answer: pca, current_memory_root: root }, 'shadow');
      expect(s.root_current).toBeNull();
      expect(s.would_abstain).toBe(false);
      expect(s.reason).toBe('grounded_at_asserted_root');
    }
  });
});
