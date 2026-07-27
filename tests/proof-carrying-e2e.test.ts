/**
 * The convergence run as a CI assertion (Patent #1 reduction-to-practice, in one test):
 * commit -> retrieve-with-proof -> bind -> revoke -> current-validity FAILS -> HAL abstains -> anchor.
 * Exercises P0-P3 + HAL-grounding together under real Poseidon2. Mirrors scripts/demo/proof-carrying-e2e.ts.
 */
import { ProofCarryingMemory, verifyProofCarryingAnswer, emitGroundedAnswer, bindAnswer } from '../src/memory/proof-carrying-memory';
import { computeGroundingSignal } from '../src/hal/hal-grounding';
import { anchorMemoryRoot } from '../src/memory/memory-root-anchor';
import { selectAnchorFn } from '../scripts/demo/proof-carrying-e2e';

describe('proof-carrying E2E — the whole loop holds (commit→prove→bind→revoke→abstain→anchor)', () => {
  const FACT = 'The Q3 audit found no material weaknesses.';

  it('an answer is grounded when the fact is committed, and abstains after it is revoked', async () => {
    const pcm = new ProofCarryingMemory();
    const v = pcm.add({ content: FACT, source_id: 'auditor-agent', source_repid: 1800, hal_verdict: 'clean', epoch: 1 });

    // committed → grounded, provable
    const pca = emitGroundedAnswer(FACT, pcm, [v]);
    expect(verifyProofCarryingAnswer(pca).grounded).toBe(true);

    // revoke → the retraction moves the root
    const rootBefore = pcm.root();
    pcm.revoke(v);
    expect(pcm.root()).not.toBe(rootBefore);

    // a fresh grounded answer citing the revoked fact must ABSTAIN
    expect(() => emitGroundedAnswer(FACT, pcm, [v])).toThrow(/abstain/);

    // the earlier answer no longer verifies against the new root; HAL would abstain
    const staleAtNewRoot = { ...pca, memory_root: pcm.root() };
    expect(verifyProofCarryingAnswer(staleAtNewRoot).grounded).toBe(false);
    expect(computeGroundingSignal({ proof_carrying_answer: staleAtNewRoot }, 'shadow').would_abstain).toBe(true);
  });

  /**
   * The test above rejects the stale answer, but `grounded=false` alone does not say WHY: swapping
   * in the new root also breaks the binding, so a rejection driven purely by `binding_mismatch`
   * would satisfy it. The patent claim is stronger than that — the INCLUSION PROOF itself must stop
   * verifying once the fact is revoked. So model the realistic adversary: one who re-binds honestly
   * at the new root, leaving the proof as the only thing standing between them and a retracted fact.
   */
  it('a re-binding adversary still fails: the inclusion proof itself breaks at the post-revocation root', () => {
    const pcm = new ProofCarryingMemory();
    const v = pcm.add({ content: FACT, source_id: 'auditor-agent', source_repid: 1800, hal_verdict: 'clean', epoch: 1 });
    const pca = emitGroundedAnswer(FACT, pcm, [v]);
    pcm.revoke(v);
    const newRoot = pcm.root();

    const rebound = { ...pca, memory_root: newRoot, binding: bindAnswer(pca.answer, pca.citations, newRoot).binding };
    const r = verifyProofCarryingAnswer(rebound);

    expect(r.binding_ok).toBe(true);              // the adversary's binding is genuinely valid…
    expect(r.verified_citations).toBe(0);         // …and the proof still fails: revocation is cryptographic
    expect(r.grounded).toBe(false);
    expect(r.reasons.some((x) => x.startsWith('citation_unverified'))).toBe(true);
    expect(r.reasons).not.toContain('binding_mismatch');
    expect(computeGroundingSignal({ proof_carrying_answer: rebound }, 'shadow').would_abstain).toBe(true);
  });

  it('the memory root anchors on-chain (injected attester, offline)', async () => {
    const pcm = new ProofCarryingMemory();
    pcm.add({ content: FACT, source_id: 'a', source_repid: 1800, hal_verdict: 'clean', epoch: 1 });
    const anchor = await anchorMemoryRoot(
      { agentId: 'auditor-agent', tier: 'AUTONOMOUS', root: pcm.root(), epoch: 2 },
      async () => ({ uid: '0xUID', txHash: '0xTX' }),
    );
    expect(anchor.anchored).toBe(true);
    expect(anchor.uid).toBe('0xUID');
  });

  /** A `--live` demo must produce a real attestation or fail — never a mock UID dressed as on-chain. */
  describe('selectAnchorFn — the demo cannot fake an on-chain anchor', () => {
    it('offline uses the mock, and the mock UID is self-labelling', async () => {
      const { fn, label } = selectAnchorFn(false, false);
      expect(label).toMatch(/offline mock/);
      const r = await fn({ proofId: 1, agentId: 'a', tier: 'AUTONOMOUS', merkleRoot: `0x${'ab'.repeat(32)}` });
      expect(r.uid).toMatch(/MOCK/);
      expect(r.uid).not.toMatch(/^0x[0-9a-fA-F]{64}$/); // can never be mistaken for a real EAS UID
    });

    it('--live without a funded attester key THROWS rather than silently mocking', () => {
      expect(() => selectAnchorFn(true, false)).toThrow(/Refusing to print a mock UID/);
    });

    it('--live with a key selects the real attester (not the mock)', async () => {
      const { fn, label } = selectAnchorFn(true, true);
      expect(label).toMatch(/LIVE/);
      const { fn: mock } = selectAnchorFn(false, false);
      expect(fn).not.toBe(mock);
    });
  });
});
