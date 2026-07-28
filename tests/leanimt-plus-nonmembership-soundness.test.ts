/**
 * NON-MEMBERSHIP SOUNDNESS — the guard that stops a live value being proved absent.
 *
 * Found by the Beat 49 adversarial verification of #240: deleting `if (L.tombstoned) return false;`
 * from `verifyNonMembership` (leanimt-plus.ts:131) SURVIVED all 111 tests of the proof-carrying
 * suite set. It is the sibling of the guard #240 pins for `verifyMembership`, and it was the only
 * surviving mutation in a 17-mutation battery.
 *
 * It is not a theoretical gap, and the reachable state is not exotic. An ORDINARY revocation retires
 * its leaf in place as `{ value: 0, next: 0, tombstoned: true }` — so after any revoke, the tree
 * contains a value-0 leaf that is NOT the sentinel. A peer who supplies that leaf as the "low leaf"
 * for some LIVE value satisfies the ordering test (`0 < v`, `next === 0` reads as the tail), and its
 * inclusion path is genuine, because the leaf really is in the tree.
 *
 * The second guard on the next line — `L.value === 0n && index !== 0` — does NOT save this: `index`
 * is a *claimed* field of an untrusted witness, and `verifyInclusion` binds only the path, so an
 * adversary simply claims `index: 0`. Nor can the adversary clear the flag by hand: the tombstone is
 * folded into the leaf encoding, so a flipped flag changes the digest and inclusion fails.
 *
 * That leaves `L.tombstoned` as the SOLE defence against proving a live value absent — the exact
 * soundness property the revocable-memory claim rests on. These tests make it load-bearing in the
 * suite as well as in the source.
 *
 * Witnesses here are rebuilt from a hand-written leaf array rather than read out of the tree's
 * privates, and the array is checked against the tree's own root first — so if the internal leaf
 * representation ever changes, this fails loudly instead of quietly testing a fiction.
 */
import {
  LeanIMTPlus, verifyMembership, verifyNonMembership, encodeLeaf,
  type IndexedLeaf, type NonMembershipWitness,
} from '../src/memory/leanimt-plus';
import { poseidon2LeafHash, poseidon2PairHash } from '../src/zkp/poseidon2-leaf';
import { referenceRoot, referenceProof } from '../src/memory/proof-carrying-index';

const pair = (a: string, b: string) => poseidon2PairHash(a, b);
const digestsOf = (leaves: IndexedLeaf[]) => leaves.map((l) => poseidon2LeafHash(encodeLeaf(l)));

/** insert 5 and 7, then revoke 5 — an entirely ordinary sequence. */
function treeWithOneOrdinaryRevocation() {
  const t = new LeanIMTPlus();
  t.insert(5n);
  t.insert(7n);
  t.revoke(5n);

  // The leaf state this SHOULD produce, written out independently of the implementation.
  const expected: IndexedLeaf[] = [
    { value: 0n, next: 7n, tombstoned: false },  // sentinel, relinked past the retracted 5
    { value: 0n, next: 0n, tombstoned: true },   // 5, retired in place — a value-0 leaf that is NOT the sentinel
    { value: 7n, next: 0n, tombstoned: false },  // 7, still live
  ];
  return { t, expected, root: t.root() };
}

describe('verifyNonMembership — the tombstoned low leaf', () => {
  it('an ordinary revoke leaves a value-0, tombstoned leaf INSIDE the committed tree (the premise)', () => {
    const { t, expected, root } = treeWithOneOrdinaryRevocation();
    // If this fails, the leaf representation moved and every witness below is fiction — fail loudly here.
    expect(referenceRoot(digestsOf(expected), pair)).toBe(root);
    expect(expected[1]!.tombstoned).toBe(true);
    expect(expected[1]!.value).toBe(0n);
    expect(verifyMembership(7n, t.membershipProof(7n), root)).toBe(true); // 7 is genuinely live
  });

  it('SOUNDNESS: the retired leaf cannot be used to prove a LIVE value absent', () => {
    const { expected, root } = treeWithOneOrdinaryRevocation();
    const digests = digestsOf(expected);

    // The adversary presents the real retired leaf, with its real inclusion path, and simply
    // CLAIMS index 0 — the one lie that neutralizes the `value === 0 && index !== 0` guard.
    const forged: NonMembershipWitness = {
      lowLeaf: { index: 0, leaf: expected[1]!, path: referenceProof(digests, 1, pair) },
    };

    // Everything except the tombstone check is satisfied — assert that explicitly, so this test
    // cannot silently degrade into "rejected for some unrelated reason".
    const L = forged.lowLeaf.leaf;
    expect(L.value === 0n && forged.lowLeaf.index !== 0).toBe(false);       // second guard: defeated
    expect(L.value < 7n && (L.next > 7n || L.next === 0n)).toBe(true);      // ordering: satisfied
    expect(L.tombstoned).toBe(true);                                        // first guard: the only one left

    expect(verifyNonMembership(7n, forged, root)).toBe(false);
  });

  it('the tombstone is bound into the digest — an adversary cannot just clear the flag', () => {
    const { expected, root } = treeWithOneOrdinaryRevocation();
    const digests = digestsOf(expected);
    const flipped: NonMembershipWitness = {
      lowLeaf: {
        index: 0,
        leaf: { ...expected[1]!, tombstoned: false },   // flag cleared, path left genuine
        path: referenceProof(digests, 1, pair),
      },
    };
    // Now the first guard does NOT fire; inclusion must reject it instead. Both doors, not one.
    expect(flipped.lowLeaf.leaf.tombstoned).toBe(false);
    expect(verifyNonMembership(7n, flipped, root)).toBe(false);
  });

  it('an honest non-membership proof for a genuinely absent value still succeeds (the guard is not a blanket no)', () => {
    const { t, root } = treeWithOneOrdinaryRevocation();
    expect(verifyNonMembership(9n, t.nonMembershipProof(9n), root)).toBe(true);   // never inserted
    expect(verifyNonMembership(5n, t.nonMembershipProof(5n), root)).toBe(true);   // revoked ⇒ provably absent
  });

  it('membership and non-membership stay mutually exclusive for the live value', () => {
    const { t, root } = treeWithOneOrdinaryRevocation();
    expect(verifyMembership(7n, t.membershipProof(7n), root)).toBe(true);
    expect(() => t.nonMembershipProof(7n)).toThrow();   // the honest API refuses to build one
  });
});

describe('revoke() domain — the sentinel is structural, not a fact', () => {
  it('revoke(0) is refused (it would tombstone the sentinel)', () => {
    const t = new LeanIMTPlus();
    t.insert(5n);
    expect(() => t.revoke(0n)).toThrow(/must be > 0/);
  });

  it('revoke of a negative value is refused', () => {
    const t = new LeanIMTPlus();
    t.insert(5n);
    expect(() => t.revoke(-1n)).toThrow(/must be > 0/);
  });

  it('the refusal leaves the tree usable — no self-loop, inserts still work', () => {
    const t = new LeanIMTPlus();
    t.insert(5n);
    const before = t.root();
    expect(() => t.revoke(0n)).toThrow();
    expect(t.root()).toBe(before);          // a rejected revoke must not mutate anything

    // The corruption this guard prevents was a predecessor relinked onto its own value
    // ({value:5, next:5}), after which every insert fails "no low leaf". Prove that didn't happen.
    expect(() => t.insert(9n)).not.toThrow();
    expect(verifyMembership(9n, t.membershipProof(9n), t.root())).toBe(true);
    expect(verifyMembership(5n, t.membershipProof(5n), t.root())).toBe(true);
  });

  it('legitimate revocation is unaffected', () => {
    const t = new LeanIMTPlus();
    t.insert(5n);
    t.revoke(5n);
    expect(verifyNonMembership(5n, t.nonMembershipProof(5n), t.root())).toBe(true);
  });
});
