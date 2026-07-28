/**
 * THE WITNESS INDEX IS NOT AUTHENTICATED — and it was gating a soundness decision.
 *
 * `verifyNonMembership` used to read `w.lowLeaf.index` to decide whether a value-0 low leaf was
 * the sentinel. Nothing binds that field: `verifyInclusion` folds `path` and never reads the
 * index, so an untrusted peer sets it to 0 for free. Measured on the pre-fix source — a committer
 * that plants ONE value-0, non-tombstoned leaf at a non-zero index could prove a LIVE value
 * ABSENT, and `verifyNonMembership` returned **true**:
 *
 *   leaves = [ {0,→7}, {0,→0}  ← poison, index 1 , {7,→0} live ]
 *   witness = { index: 0 (LIED), leaf: poison, path: <genuine path for index 1> }
 *   verifyNonMembership(7n, witness, root) === true      // 7 is live, and provably absent
 *
 * The tombstone guard does NOT catch it: the poison leaf is not tombstoned. It works with any
 * `next` pointer (0 reads as the tail; a large value reads as "the next active value is above v").
 *
 * The fix derives the slot from the PATH instead, which the root does bind: a leaf is leftmost iff
 * its sibling is on the right at every level. These tests pin (1) that the equivalence holds for
 * every index at many tree sizes, (2) that the forgery is refused, and (3) that no verifier's
 * verdict can be moved by lying about the index at all.
 */
import {
  LeanIMTPlus, verifyMembership, verifyNonMembership, encodeLeaf,
  type IndexedLeaf, type NonMembershipWitness,
} from '../src/memory/leanimt-plus';
import { poseidon2LeafHash, poseidon2PairHash } from '../src/zkp/poseidon2-leaf';
import { referenceRoot, referenceProof } from '../src/memory/proof-carrying-index';

const pair = (a: string, b: string) => poseidon2PairHash(a, b);
const digestsOf = (ls: IndexedLeaf[]) => ls.map((l) => poseidon2LeafHash(encodeLeaf(l)));

/** Every index a witness could claim, including nonsense ones. */
const CLAIMED = [0, 1, 2, 3, 7, 99, -1];

describe('the leftmost-slot test is equivalent to index 0 — for every leaf, at many sizes', () => {
  // The guard is only sound if `path.every(sibling on the right)` really does single out index 0.
  // A lone promoted node always sits at an EVEN position, so promotion cannot hide a left-sibling
  // step — but that is an argument, so measure it across odd and even leaf counts.
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 16, 17])('%i leaves', (n) => {
    const digests = Array.from({ length: n }, (_, i) => poseidon2LeafHash(`leaf-${i}`));
    for (let i = 0; i < n; i++) {
      const leftmost = referenceProof(digests, i, pair).every((s) => !s.siblingOnLeft);
      expect(leftmost).toBe(i === 0);
    }
  });
});

describe('SOUNDNESS: a planted value-0 leaf cannot prove a live value absent', () => {
  /** A committed tree containing a poison leaf at index 1: value 0, NOT tombstoned. */
  function poisonedTree(poisonNext: bigint) {
    const leaves: IndexedLeaf[] = [
      { value: 0n, next: 7n, tombstoned: false },        // sentinel
      { value: 0n, next: poisonNext, tombstoned: false },// POISON — value 0, alive, index 1
      { value: 7n, next: 0n, tombstoned: false },        // 7 is LIVE
    ];
    const digests = digestsOf(leaves);
    return { leaves, digests, root: referenceRoot(digests, pair) };
  }

  // next=0 reads as "tail"; next=999999 reads as "the next active value is above 7". Both satisfy
  // the ordering test, so the guard is the only thing standing between them and a false absence.
  it.each([[0n], [999999n]])('poison leaf with next=%s is refused however it claims its index', (poisonNext) => {
    const { leaves, digests, root } = poisonedTree(poisonNext as bigint);
    const L = leaves[1]!;

    // Assert the attack is otherwise LIVE, so this test cannot pass by the forgery being toothless.
    expect(L.tombstoned).toBe(false);                                  // tombstone guard: does not fire
    expect(L.value < 7n && (L.next > 7n || L.next === 0n)).toBe(true); // ordering: satisfied
    expect(verifyMembership(7n, { index: 2, leaf: leaves[2]!, path: referenceProof(digests, 2, pair) }, root))
      .toBe(true);                                                     // and 7 really is live at this root

    for (const index of CLAIMED) {
      const forged: NonMembershipWitness = { lowLeaf: { index, leaf: L, path: referenceProof(digests, 1, pair) } };
      expect(verifyNonMembership(7n, forged, root)).toBe(false);
    }
  });

  it('membership and non-membership cannot both hold for the same value at the same root', () => {
    const { leaves, digests, root } = poisonedTree(0n);
    const member = verifyMembership(7n, { index: 2, leaf: leaves[2]!, path: referenceProof(digests, 2, pair) }, root);
    const absent = verifyNonMembership(7n, { lowLeaf: { index: 0, leaf: leaves[1]!, path: referenceProof(digests, 1, pair) } }, root);
    expect(member).toBe(true);
    expect(absent).toBe(false);   // pre-fix this was ALSO true — the memory was not a function
  });
});

describe('no verdict may depend on the claimed index', () => {
  function fixtures() {
    const t = new LeanIMTPlus();
    t.insert(5n); t.insert(7n); t.insert(11n);
    const revoked = new LeanIMTPlus();
    revoked.insert(10n); revoked.insert(20n); revoked.revoke(10n);
    const empty = new LeanIMTPlus();
    return { t, revoked, empty };
  }

  it('membership: forging the index never changes the answer (true stays true, false stays false)', () => {
    const { t } = fixtures();
    const root = t.root();
    const honest = t.membershipProof(7n);
    for (const index of CLAIMED) {
      expect(verifyMembership(7n, { ...honest, index }, root)).toBe(true);
      expect(verifyMembership(11n, { ...honest, index }, root)).toBe(false); // wrong value, still refused
    }
  });

  it('non-membership: forging the index never changes the answer, on every honest shape', () => {
    const { t, revoked, empty } = fixtures();
    const cases: Array<[string, LeanIMTPlus, bigint]> = [
      ['ordinary low leaf (value > 0)', t, 9n],
      ['sentinel low leaf (below the smallest)', t, 1n],
      ['revoked value', revoked, 10n],
      ['empty tree', empty, 4n],
    ];
    for (const [, tree, v] of cases) {
      const honest = tree.nonMembershipProof(v);
      for (const index of CLAIMED) {
        expect(verifyNonMembership(v, { lowLeaf: { ...honest.lowLeaf, index } }, tree.root())).toBe(true);
      }
    }
  });
});

describe('the honest paths are unaffected by the new guard', () => {
  it('empty tree: the sentinel is the low leaf and its path is empty', () => {
    const e = new LeanIMTPlus();
    expect(e.nonMembershipProof(4n).lowLeaf.path).toHaveLength(0);
    expect(verifyNonMembership(4n, e.nonMembershipProof(4n), e.root())).toBe(true);
  });

  it('a value below the smallest member verifies via the sentinel', () => {
    const t = new LeanIMTPlus();
    t.insert(10n); t.insert(20n);
    const w = t.nonMembershipProof(5n);
    expect(w.lowLeaf.leaf.value).toBe(0n);   // it IS the sentinel — the guard's live case
    expect(verifyNonMembership(5n, w, t.root())).toBe(true);
  });

  it('revocation still yields a provable absence, and the live sibling stays provable', () => {
    const t = new LeanIMTPlus();
    t.insert(10n); t.insert(20n); t.revoke(10n);
    expect(verifyNonMembership(10n, t.nonMembershipProof(10n), t.root())).toBe(true);
    expect(verifyMembership(20n, t.membershipProof(20n), t.root())).toBe(true);
  });

  it('a genuinely present value still has no honest non-membership proof', () => {
    const t = new LeanIMTPlus();
    t.insert(10n);
    expect(() => t.nonMembershipProof(10n)).toThrow();
  });
});
