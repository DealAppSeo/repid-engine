/**
 * The convergence run as a CI assertion (Patent #1 reduction-to-practice, in one test):
 * commit -> retrieve-with-proof -> bind -> revoke -> current-validity FAILS -> HAL abstains -> anchor.
 * Exercises P0-P3 + HAL-grounding together under real Poseidon2. Mirrors scripts/demo/proof-carrying-e2e.ts.
 */
import { ProofCarryingMemory, verifyProofCarryingAnswer, emitGroundedAnswer } from '../src/memory/proof-carrying-memory';
import { computeGroundingSignal } from '../src/hal/hal-grounding';
import { anchorMemoryRoot } from '../src/memory/memory-root-anchor';

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
});
