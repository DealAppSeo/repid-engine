/**
 * PATENT #1 — INTEGRATED LIFECYCLE E2E: commit → anchor → retrieve → bind → verify →
 * REVOKE → provable staleness → proof-of-absence → abstain → re-anchor.
 *
 * WHY THIS FILE EXISTS (reduction to practice, not extra coverage).
 * Every layer of the claim already has its own unit suite — P0 leaf
 * (`proof-carrying-index`), P1 accumulator (`leanimt-plus`), P2 retrieval +
 * answer-binding (`proof-carrying-memory`), P3 EAS anchoring
 * (`memory-root-anchor`), and the HAL abstain signal (`hal-grounding`). What no
 * test did was walk the claim AS A WHOLE across those module boundaries in one
 * run. The catalog records that as reduction-to-practice gap (b), and a patent
 * claim is granted on the combination, not on the parts: the parts passing
 * separately is not evidence that the composed system behaves as claimed.
 *
 * Concretely, three joints were only ever exercised against synthetic stand-ins:
 *   • P3 anchored a hand-written root string, never a root a `ProofCarryingMemory`
 *     had actually committed — so "the anchored root is the root the answer was
 *     bound to" was assumed, not shown.
 *   • `hal-grounding` computed its signal from a hand-TAMPERED answer, never from
 *     one made stale by a genuine revocation — the abstain path fired, but never
 *     for the reason the primitive exists.
 *   • `ProofCarryingMemory.nonMembershipWitness` was exported and never called by
 *     any P2-level test. Retraction was shown as "membership stops verifying"
 *     (absence of proof) and never as "absence verifies" (PROOF of absence).
 *     Those are different claims and only the second one is the patent's.
 *
 * Runs under real Poseidon2-BabyBear (module defaults — no injected fakes), so a
 * pass is evidence about the shipped cryptography, not about a test double.
 */
import {
  ProofCarryingMemory, verifyProofCarryingAnswer, emitGroundedAnswer, bindAnswer,
  type MemoryEntry, type ProofCarryingAnswer,
} from '../src/memory/proof-carrying-memory';
import { verifyMembership, verifyNonMembership } from '../src/memory/leanimt-plus';
import {
  anchorMemoryRoot, buildMemoryRootAttest, MEMORY_ROOT_PROOF_TYPE,
  type AttestFn,
} from '../src/memory/memory-root-anchor';
import { computeGroundingSignal } from '../src/hal/hal-grounding';

const AGENT = 'trinity-sophia';
const TIER = 'ESTABLISHED';

function entry(content: string, epoch: number, repid = 1200): MemoryEntry {
  return { content, source_id: AGENT, source_repid: repid, hal_verdict: 'clean', epoch };
}

/** Structural snapshot of an answer. BigInt-aware: witness leaves carry `value`/`next` as bigint. */
function freeze(x: unknown): string {
  return JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
}

/**
 * Chain write recorded rather than performed. Every call is captured so the test can assert
 * WHAT would go on-chain — the real `attestProof` needs a funded key, and the one genuinely
 * missing piece of evidence (a live Base-Sepolia anchor of a memory root) is tracked as gap
 * (c) in PATENT_EVIDENCE_CATALOG_v1 rather than faked here.
 */
function recordingAttester() {
  const calls: Array<{ merkleRoot: string; proofType: string; proofId: number; agentId: string; tier: string }> = [];
  const fn: AttestFn = async (input) => {
    calls.push({
      merkleRoot: String(input.merkleRoot), proofType: String(input.proofType),
      proofId: Number(input.proofId), agentId: String(input.agentId), tier: String(input.tier),
    });
    return { uid: `0x${'ab'.repeat(32)}`, txHash: `0x${'cd'.repeat(32)}` };
  };
  return { fn, calls };
}

describe('Patent #1 — full lifecycle across P0/P1/P2/P3 + HAL, under real Poseidon2', () => {
  it('commit → anchor → bind → verify → revoke → prove absence → abstain → re-anchor', async () => {
    const mem = new ProofCarryingMemory();
    const attester = recordingAttester();

    // ── 1. COMMIT ─────────────────────────────────────────────────────────────
    // Three reputation-weighted entries. `vClaim` is the one that will later be retracted.
    const vClaim = mem.add(entry('BabyBear prime p = 2^31 - 2^27 + 1', 1));
    const vDurable = mem.add(entry('Poseidon2 is the HyperDAG canonical hash', 1));
    mem.add(entry('EAS anchors live on Base Sepolia', 1));

    const rootAtCommit = mem.root();
    expect(rootAtCommit).toMatch(/^0x[0-9a-f]{64}$/);

    // ── 2. ANCHOR the committed root (P3) ─────────────────────────────────────
    // The joint that mattered and was never tested: what goes on-chain is the root the
    // memory actually holds, not a root supplied alongside it.
    const anchor1 = await anchorMemoryRoot(
      { agentId: AGENT, tier: TIER, root: rootAtCommit, epoch: 1, repidSnapshot: 1200 }, attester.fn,
    );
    expect(anchor1.anchored).toBe(true);
    expect(attester.calls).toHaveLength(1);
    expect(attester.calls[0]!.merkleRoot).toBe(rootAtCommit);      // ← the actual join
    expect(attester.calls[0]!.proofType).toBe(MEMORY_ROOT_PROOF_TYPE);

    // ── 3. RETRIEVE with proofs ───────────────────────────────────────────────
    const hits = mem.retrieve((e) => e.content.includes('BabyBear'));
    expect(hits).toHaveLength(1);
    expect(verifyMembership(BigInt(hits[0]!.value), hits[0]!.witness, rootAtCommit)).toBe(true);

    // ── 4. BIND an answer to the cited proof set ──────────────────────────────
    const answer = emitGroundedAnswer('The BabyBear prime is 2^31 - 2^27 + 1.', mem, [vClaim]);
    expect(answer.memory_root).toBe(rootAtCommit);
    expect(answer.citations).toHaveLength(1);

    // ── 5. VERIFY independently, and through HAL ──────────────────────────────
    expect(verifyProofCarryingAnswer(answer).grounded).toBe(true);
    const signalBefore = computeGroundingSignal({ proof_carrying_answer: answer }, 'enforce');
    expect(signalBefore.grounded).toBe(true);
    expect(signalBefore.would_abstain).toBe(false);

    // Freeze the exact bytes so step 7 can prove the answer did not change — only the world did.
    const frozen = freeze(answer);

    // ── 6. REVOKE (provable retraction) ───────────────────────────────────────
    mem.revoke(vClaim);
    const rootAfterRevoke = mem.root();
    expect(rootAfterRevoke).not.toBe(rootAtCommit);   // retraction moves the commitment
    expect(mem.retrieve((e) => e.content.includes('BabyBear'))).toHaveLength(0);

    // ── 7. PROVABLE STALENESS — the answer is untouched; it is the ROOT that moved ──
    // This is the distinction the claim turns on. The answer still verifies perfectly
    // against the root it was bound to (it was honestly produced and is unforged), and
    // fails against current memory (it is no longer CURRENT-VALID). Staleness is a
    // property of the world, not evidence of tampering — and the two are told apart.
    expect(freeze(answer)).toBe(frozen);                                  // bytes unchanged
    expect(verifyProofCarryingAnswer(answer).grounded).toBe(true);        // still valid at its own root
    const atCurrentRoot: ProofCarryingAnswer = { ...answer, memory_root: rootAfterRevoke };
    expect(verifyProofCarryingAnswer(atCurrentRoot).grounded).toBe(false); // stale against current memory

    // ── 7b. A RE-BIND CANNOT LAUNDER A RETRACTED CITATION ─────────────────────
    // The obvious attack: re-bind the stale citation to the new root so the binding is
    // internally consistent again. It still fails, because the citation's own membership
    // proof does not verify against the post-revocation root. Binding integrity and
    // current-validity are independent gates and BOTH must hold.
    const relaundered = bindAnswer(answer.answer, answer.citations, rootAfterRevoke);
    const laundered = verifyProofCarryingAnswer(relaundered);
    expect(laundered.binding_ok).toBe(true);      // the forger fixed the binding …
    expect(laundered.grounded).toBe(false);       // … and it bought them nothing
    expect(laundered.verified_citations).toBe(0);

    // ── 8. PROOF OF ABSENCE, not absence of proof ─────────────────────────────
    // The affirmative half of "provable retraction": a verifier is handed a witness that
    // PROVES the retracted value is not in the current root. Nothing at this layer
    // exercised this; without it, retraction is only ever "we failed to prove presence".
    const nonMembership = mem.nonMembershipWitness(vClaim);
    expect(verifyNonMembership(BigInt(vClaim), nonMembership, rootAfterRevoke)).toBe(true);
    // …and it is specific: it does not "prove" absence of an entry that is still present.
    expect(verifyNonMembership(BigInt(vDurable), nonMembership, rootAfterRevoke)).toBe(false);

    // ── 9. ABSTAIN — no proof ⇒ no answer ─────────────────────────────────────
    expect(() => emitGroundedAnswer('still cites the retracted fact', mem, [vClaim]))
      .toThrow(/^abstain: /);
    const signalAfter = computeGroundingSignal({ proof_carrying_answer: atCurrentRoot }, 'enforce');
    expect(signalAfter.would_abstain).toBe(true);
    expect(signalAfter.grounded).toBe(false);
    expect(signalAfter.verified_citations).toBe(0);

    // ── 10. RE-ANCHOR — the retraction itself becomes publicly timestamped ─────
    const anchor2 = await anchorMemoryRoot(
      { agentId: AGENT, tier: TIER, root: rootAfterRevoke, epoch: 2, repidSnapshot: 1200 }, attester.fn,
    );
    expect(anchor2.anchored).toBe(true);
    expect(attester.calls).toHaveLength(2);
    expect(attester.calls[1]!.merkleRoot).toBe(rootAfterRevoke);
    expect(attester.calls[1]!.merkleRoot).not.toBe(attester.calls[0]!.merkleRoot);
    expect(attester.calls[1]!.proofId).toBe(2);   // distinct epoch → distinct attestation

    // ── 11. REVOCATION IS SURGICAL ────────────────────────────────────────────
    // Everything not retracted survives and can still ground an answer at the new root.
    const durable = emitGroundedAnswer('Poseidon2 is canonical.', mem, [vDurable]);
    expect(durable.memory_root).toBe(rootAfterRevoke);
    expect(verifyProofCarryingAnswer(durable).grounded).toBe(true);
  });

  it('an answer citing BOTH a live and a retracted entry abstains entirely — no partial grounding', () => {
    // The composed system must not emit a half-proved answer. Per-citation verification is
    // already unit-tested; what matters here is that the EMIT path refuses the whole answer
    // rather than silently dropping the unprovable citation and answering anyway.
    const mem = new ProofCarryingMemory();
    const vGone = mem.add(entry('a fact later retracted', 1));
    const vLive = mem.add(entry('a fact that stands', 1));
    mem.revoke(vGone);

    expect(() => emitGroundedAnswer('mixes both', mem, [vLive, vGone])).toThrow(/^abstain: /);
    // …while the live citation alone still grounds — the refusal is about the retracted one.
    expect(verifyProofCarryingAnswer(emitGroundedAnswer('cites the live one', mem, [vLive])).grounded).toBe(true);
  });

  it('the anchored root is a commitment: any later mutation of memory invalidates it', async () => {
    // Ties P3 back to P0/P1 — an anchor is only meaningful if the root it pinned cannot
    // silently absorb new content. Appending moves the root, so the earlier attestation
    // provably describes an earlier state rather than "memory" in general.
    const mem = new ProofCarryingMemory();
    mem.add(entry('first', 1));
    const anchored = mem.root();

    const attester = recordingAttester();
    await anchorMemoryRoot({ agentId: AGENT, tier: TIER, root: anchored, epoch: 1 }, attester.fn);

    mem.add(entry('appended after anchoring', 2));
    expect(mem.root()).not.toBe(anchored);
    expect(attester.calls[0]!.merkleRoot).toBe(anchored); // the attestation still names the old state

    // And the mapping onto the EAS schema is stable//pure for that pinned root.
    expect(buildMemoryRootAttest({ agentId: AGENT, tier: TIER, root: anchored, epoch: 1 }).merkleRoot).toBe(anchored);
  });
});
