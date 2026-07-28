/**
 * revoked-leaf-witness-pin.test.ts — isolates the TOMBSTONE check in `verifyMembership`.
 *
 * WHY: two independent verifications (PR #220's battery, and the medical-grounding eval's) each
 * found that deleting `w.leaf.tombstoned ||` from `verifyMembership` SURVIVES every existing suite.
 * The reason is the same in both: every test revokes and then re-checks against a NEW root, and
 * `revoke()` moves the root — so "the path no longer recombines" already fails the check and the
 * tombstone flag is never the deciding factor. That makes root-staleness the only tested line of
 * defence, when the contract claims two.
 *
 * The gap is not academic. A verifier that checks a citation against the root it was bound to
 * (a per-citation cached root — a plausible refactor, and what an on-chain checker with a pinned
 * root would naturally do) loses the staleness defence entirely, and the tombstone flag becomes
 * the ONLY thing separating a revoked leaf from a live one.
 *
 * So this test attacks the flag directly, at the SAME root, with a hand-built witness — which is
 * the honest adversarial model: a witness is untrusted data that arrives from a peer, not something
 * the verifier obtains from its own tree.
 *
 * The sharp edge: `revoke()` zeroes the leaf's value, and the SENTINEL's value is also zero. So a
 * revoked leaf and the sentinel are indistinguishable by value; `tombstoned` is the entire
 * difference. This test asserts both sides of that — the sentinel witness verifies, the revoked
 * leaf's witness must not.
 */
import {
  LeanIMTPlus, encodeLeaf, verifyMembership, verifyCurrentValidity,
  type IndexedLeaf, type InclusionWitness,
} from '../src/memory/leanimt-plus';
import { referenceRoot, referenceProof, type Hash2 } from '../src/memory/proof-carrying-index';
import { poseidon2LeafHash, poseidon2PairHash } from '../src/zkp/poseidon2-leaf';

const leafHash = poseidon2LeafHash;
const pair: Hash2 = (a, b) => poseidon2PairHash(a, b);

/**
 * A tree with exactly one inserted value, then revoked. Its leaf array is then fully determined:
 *   [0] sentinel   { value: 0, next: 0, tombstoned: false }   (revoke relinked it past v)
 *   [1] the revoke { value: 0, next: 0, tombstoned: true  }
 * We reconstruct that array rather than reaching into the class's privates, and ASSERT the
 * reconstruction reproduces the tree's own root — so if the internal representation ever changes,
 * this test fails loudly instead of quietly testing a fiction.
 */
function revokedSingleLeafTree() {
  const v = 424242n;
  const tree = new LeanIMTPlus();
  tree.insert(v);
  tree.revoke(v);

  const sentinel: IndexedLeaf = { value: 0n, next: 0n, tombstoned: false };
  const revoked: IndexedLeaf = { value: 0n, next: 0n, tombstoned: true };
  const digests = [sentinel, revoked].map((l) => leafHash(encodeLeaf(l)));
  const root = referenceRoot(digests, pair);

  return { v, tree, sentinel, revoked, digests, root };
}

describe('the tombstone flag is checked, at the same root, on an untrusted witness', () => {
  it('the reconstructed leaf array reproduces the tree\'s own root (guard on the guard)', () => {
    const { tree, root } = revokedSingleLeafTree();
    expect(root).toBe(tree.root());
  });

  it('POSITIVE CONTROL — a witness for the non-tombstoned sentinel (value 0) DOES verify', () => {
    // This is what makes the negative below meaningful: the crafted-witness machinery is correct,
    // and value 0 is genuinely provable at this root — via the sentinel.
    const { digests, root, sentinel } = revokedSingleLeafTree();
    const w: InclusionWitness = { index: 0, leaf: sentinel, path: referenceProof(digests, 0, pair) };
    expect(verifyMembership(0n, w, root)).toBe(true);
  });

  it('a witness for the REVOKED leaf must NOT verify — same root, same value, only the flag differs', () => {
    const { digests, root, revoked } = revokedSingleLeafTree();
    const w: InclusionWitness = { index: 1, leaf: revoked, path: referenceProof(digests, 1, pair) };
    // Everything except the flag is genuine: the leaf is byte-identical to the one in the tree, the
    // path is the real path, and it recombines to the CURRENT root. Deleting the tombstone check
    // from verifyMembership turns this into `true` — a retracted fact provable as current.
    expect(verifyMembership(0n, w, root)).toBe(false);
    expect(verifyCurrentValidity(0n, w, root)).toBe(false);
  });

  it('the revoked value itself is not provable either (the value check, tested separately)', () => {
    const { v, digests, root, revoked } = revokedSingleLeafTree();
    const w: InclusionWitness = { index: 1, leaf: revoked, path: referenceProof(digests, 1, pair) };
    expect(verifyMembership(v, w, root)).toBe(false); // leaf.value (0) !== v
  });

  it('a pre-revocation witness cannot be re-flagged to sneak past — the digest changes', () => {
    // The other direction: an attacker who kept the ACTIVE witness and flips nothing still fails,
    // because the tree moved. Pins that root-staleness (the previously-only defence) still holds.
    const v = 424242n;
    const tree = new LeanIMTPlus();
    tree.insert(v);
    const stale = tree.membershipProof(v);
    const rootBefore = tree.root();
    expect(verifyMembership(v, stale, rootBefore)).toBe(true);
    tree.revoke(v);
    expect(verifyMembership(v, stale, tree.root())).toBe(false);
  });
});
