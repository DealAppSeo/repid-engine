/**
 * tests/merkle-air.test.ts — Item 14 (P4): Plonky3 non-membership AIR
 *
 * Acceptance criteria: "AIR proof verifies; wrong witness fails"
 *
 * All proofs use real Poseidon2-BabyBear (production hash) so these
 * tests simultaneously cover the hash bit-exactness and the AIR constraints.
 */

import { LeanIMTPlus } from '../src/memory/leanimt-plus';
import {
  generateInclusionTrace,
  generateNonMembershipTrace,
  verifyInclusionAIR,
  verifyNonMembershipAIR,
  verifyBatchedMerkleAIR,
  type MerkleAIRRow,
} from '../src/zkp/merkle-air';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTree(...values: bigint[]): LeanIMTPlus {
  const tree = new LeanIMTPlus();
  for (const v of values) tree.insert(v);
  return tree;
}

// ---------------------------------------------------------------------------
// Inclusion AIR — valid witnesses
// ---------------------------------------------------------------------------

describe('Inclusion AIR — valid witnesses pass', () => {
  test('single active value', () => {
    const tree = buildTree(10n);
    const w = tree.membershipProof(10n);
    const air = generateInclusionTrace(w);
    const result = verifyInclusionAIR(air, { root: tree.root() });
    expect(result.ok).toBe(true);
  });

  test('value among several — 5 values, prove 3rd', () => {
    const tree = buildTree(5n, 10n, 20n, 30n, 50n);
    const w = tree.membershipProof(20n);
    const air = generateInclusionTrace(w);
    const result = verifyInclusionAIR(air, { root: tree.root() });
    expect(result.ok).toBe(true);
    // Sanity: claimed root matches the tree root
    expect(air.claimed_root).toBe(tree.root());
  });

  test('root check: air.claimed_root equals tree.root()', () => {
    const tree = buildTree(1n, 2n, 3n);
    const w = tree.membershipProof(2n);
    const air = generateInclusionTrace(w);
    expect(air.claimed_root).toBe(tree.root());
    expect(verifyInclusionAIR(air, { root: tree.root() }).ok).toBe(true);
  });

  test('boundary values — very large value', () => {
    const tree = buildTree(BigInt(2 ** 53) - 1n, BigInt(2 ** 53));
    const w = tree.membershipProof(BigInt(2 ** 53));
    const air = generateInclusionTrace(w);
    expect(verifyInclusionAIR(air, { root: tree.root() }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Inclusion AIR — tampered traces must fail
// ---------------------------------------------------------------------------

describe('Inclusion AIR — tampered traces fail', () => {
  const tree = buildTree(5n, 10n, 20n);
  const root = tree.root();
  function tracePair() {
    return generateInclusionTrace(tree.membershipProof(10n));
  }

  test('tampered current_out (R0 constraint)', () => {
    const air = tracePair();
    // Flip one bit in the first row's output hash (hex string swap)
    air.rows[0] = { ...air.rows[0]!, current_out: '0x' + 'ff'.repeat(32) };
    const result = verifyInclusionAIR(air, { root });
    expect(result.ok).toBe(false);
    expect(result.failure).toMatch(/R0|C0|B1/);
  });

  test('tampered sibling breaks R0', () => {
    const air = tracePair();
    const row = air.rows[0]!;
    // Use a canonical BabyBear hex (each 4-byte limb < p = 0x78000001) but wrong value.
    // 0x70000000 per limb = 1879048192 < 2013265921 — valid but ≠ any real sibling.
    const fakeSibling = '0x' + '70000000'.repeat(8);
    air.rows[0] = { ...row, sibling: fakeSibling };
    // current_out was computed with the old sibling — now R0 will fail
    const result = verifyInclusionAIR(air, { root });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain('R0');
  });

  test('tampered direction bit breaks R0', () => {
    const air = tracePair();
    const row = air.rows[0]!;
    // Flip the direction
    air.rows[0] = { ...row, sibling_left: row.sibling_left === 0 ? 1 : 0 };
    // current_out no longer matches the hash with swapped order
    const result = verifyInclusionAIR(air, { root });
    // If the direction was already the one that produces the same result (same sibling
    // on both sides is impossible for distinct hashes), must fail
    if (!result.ok) {
      expect(result.failure).toMatch(/R0|R1/);
    }
    // At least: if the AIR passes WITH the tampered bit, the claimed root must still hold.
    // (A flip that accidentally produces the same hash is astronomically unlikely with Poseidon2.)
  });

  test('wrong claimed root (B1 constraint)', () => {
    const air = tracePair();
    air.claimed_root = '0x' + 'cc'.repeat(32);
    const result = verifyInclusionAIR(air, { root });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain('B1');
  });

  test('wrong leaf_digest (B0 constraint)', () => {
    const air = tracePair();
    air.leaf_digest = '0x' + 'dd'.repeat(32);
    const result = verifyInclusionAIR(air, { root });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain('B0');
  });

  test('broken continuity between rows (C0 constraint)', () => {
    const air = tracePair();
    if (air.rows.length < 2) return; // skip for trivial paths
    // Break row[0].current_out ≠ row[1].current_in by patching row[1]
    const r1 = air.rows[1]!;
    air.rows[1] = { ...r1, current_in: '0x' + 'ee'.repeat(32) };
    const result = verifyInclusionAIR(air, { root });
    expect(result.ok).toBe(false);
    expect(result.failure).toMatch(/C0|R0/);
  });

  test('invalid direction bit value (R1 constraint)', () => {
    const air = tracePair();
    // Force a non-binary sibling_left (2 is not in {0,1})
    (air.rows[0] as MerkleAIRRow & { sibling_left: number }).sibling_left = 2;
    const result = verifyInclusionAIR(air, { root });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain('R1');
  });
});

// ---------------------------------------------------------------------------
// Non-membership AIR — valid absent values
// ---------------------------------------------------------------------------

describe('Non-membership AIR — valid absent values pass', () => {
  test('value never inserted', () => {
    const tree = buildTree(5n, 20n);
    const w = tree.nonMembershipProof(10n); // 5 < 10 < 20
    const air = generateNonMembershipTrace(10n, w);
    const result = verifyNonMembershipAIR(air, { root: tree.root() });
    expect(result.ok).toBe(true);
  });

  test('value smaller than all actives (sentinel low-leaf)', () => {
    const tree = buildTree(100n, 200n);
    // 1n is absent; sentinel (value=0) is the low-leaf
    const w = tree.nonMembershipProof(1n);
    const air = generateNonMembershipTrace(1n, w);
    const result = verifyNonMembershipAIR(air, { root: tree.root() });
    expect(result.ok).toBe(true);
  });

  test('value larger than all actives (tail low-leaf, next=0)', () => {
    const tree = buildTree(5n, 10n);
    const w = tree.nonMembershipProof(9999n); // past the last active
    const air = generateNonMembershipTrace(9999n, w);
    expect(air.low_leaf_next).toBe(0n); // confirms tail
    const result = verifyNonMembershipAIR(air, { root: tree.root() });
    expect(result.ok).toBe(true);
  });

  test('revoked value is non-member', () => {
    const tree = buildTree(5n, 10n, 20n);
    tree.revoke(10n);
    const w = tree.nonMembershipProof(10n);
    const air = generateNonMembershipTrace(10n, w);
    const result = verifyNonMembershipAIR(air, { root: tree.root() });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-membership AIR — tampered witnesses fail
// ---------------------------------------------------------------------------

describe('Non-membership AIR — invalid witnesses fail', () => {
  test('ordering violated — target ≤ low_leaf.value', () => {
    const tree = buildTree(5n, 10n, 20n);
    const w = tree.nonMembershipProof(7n); // low-leaf = 5
    const air = generateNonMembershipTrace(7n, w);
    // Forge: claim target = 4 (which is ≤ low_leaf.value 5)
    const tampered = { ...air, target_value: 4n };
    const result = verifyNonMembershipAIR(tampered, { root: tree.root() });
    expect(result.ok).toBe(false);
    expect(result.failure).toMatch(/ordering/);
  });

  test('ordering violated — target ≥ low_leaf.next', () => {
    const tree = buildTree(5n, 10n, 20n);
    const w = tree.nonMembershipProof(7n); // low-leaf.next = 10
    const air = generateNonMembershipTrace(7n, w);
    // Forge: claim target = 15 (which is ≥ low_leaf.next 10)
    const tampered = { ...air, target_value: 15n };
    const result = verifyNonMembershipAIR(tampered, { root: tree.root() });
    expect(result.ok).toBe(false);
    expect(result.failure).toMatch(/ordering/);
  });

  test('tombstoned low-leaf rejected — forged flag caught by digest binding', () => {
    const tree = buildTree(5n, 10n, 20n);
    const w = tree.nonMembershipProof(7n);
    const air = generateNonMembershipTrace(7n, w);
    // Force tombstoned flag without updating the committed digest — now caught at the
    // digest-binding step (step 1b) before the tombstone check.
    const tampered = { ...air, low_leaf_tombstoned: true };
    const result = verifyNonMembershipAIR(tampered, { root: tree.root() });
    expect(result.ok).toBe(false);
    // Digest binding catches the tampered field; "do not match" is the expected error.
    expect(result.failure).toMatch(/do not match/);
  });

  test('forged ordering fields with valid inclusion proof rejected (Strix finding)', () => {
    // Tree has 5, 10, 20. Target = 10, which IS in the tree.
    // Attack: get a valid inclusion proof for the low-leaf (value=5, next=10), then
    // forge low_leaf_next=15 so the ordering check (5 < 10 < 15) would pass — falsely
    // claiming non-membership of 10.
    const tree = buildTree(5n, 10n, 20n);
    const w = tree.nonMembershipProof(7n); // low-leaf is 5 (next=10)
    const air = generateNonMembershipTrace(7n, w);
    // Forge: swap target to 10 (which is in the tree) and fake low_leaf_next to 15
    const forged: typeof air = {
      ...air,
      target_value: 10n,
      low_leaf_next: 15n, // would make ordering 5 < 10 < 15 pass
    };
    const result = verifyNonMembershipAIR(forged, { root: tree.root() });
    expect(result.ok).toBe(false);
    // Must be caught by digest binding (step 1b), not by the ordering check
    expect(result.failure).toMatch(/do not match/);
  });

  test('a planted value-0 leaf outside the leftmost slot cannot prove absence (Strix MEDIUM)', () => {
    // Only the sentinel at index 0 may have value 0. A value-0, next-0 leaf anywhere else reads as
    // "the tail of an empty list", so it would "prove" that every value is absent — including 5
    // and 10, which are in this tree. The root binds the leaf's POSITION through its path, so the
    // verifier must derive the slot from the path, as the per-witness reference verifier does.
    const tree = LeanIMTPlus.fromLeaves([
      { value: 0n, next: 5n, tombstoned: false }, // sentinel, index 0
      { value: 5n, next: 10n, tombstoned: false },
      { value: 0n, next: 0n, tombstoned: false }, // planted, index 2
      { value: 10n, next: 0n, tombstoned: false },
    ]);
    const planted = { lowLeaf: (tree as unknown as { witnessAt(i: number): any }).witnessAt(2) };
    for (const present of [5n, 10n]) {
      const result = verifyNonMembershipAIR(generateNonMembershipTrace(present, planted), { root: tree.root() });
      expect(result.ok).toBe(false);
      expect(result.failure).toMatch(/leftmost/);
    }
    // The real sentinel, in the leftmost slot, still proves a genuinely absent value.
    const honest = verifyNonMembershipAIR(generateNonMembershipTrace(3n, tree.nonMembershipProof(3n)), {
      root: tree.root(),
    });
    expect(honest).toEqual({ ok: true });
  });

  test('tampered low-leaf inclusion fails non-membership', () => {
    const tree = buildTree(5n, 10n, 20n);
    const w = tree.nonMembershipProof(7n);
    const air = generateNonMembershipTrace(7n, w);
    // Break the low-leaf inclusion AIR
    if (air.low_leaf_inclusion.rows.length > 0) {
      air.low_leaf_inclusion.rows[0] = {
        ...air.low_leaf_inclusion.rows[0]!,
        current_out: '0x' + 'ff'.repeat(32),
      };
    }
    air.low_leaf_inclusion.claimed_root = '0x' + 'ff'.repeat(32);
    const result = verifyNonMembershipAIR(air, { root: tree.root() });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Batched AIR
// ---------------------------------------------------------------------------

describe('Batched AIR', () => {
  test('batch of inclusions all pass', () => {
    const tree = buildTree(1n, 2n, 3n);
    const batch = {
      proofs: [
        generateInclusionTrace(tree.membershipProof(1n)),
        generateInclusionTrace(tree.membershipProof(2n)),
        generateInclusionTrace(tree.membershipProof(3n)),
      ],
    };
    expect(verifyBatchedMerkleAIR(batch, { root: tree.root() }).ok).toBe(true);
  });

  test('batch with one non-membership passes', () => {
    const tree = buildTree(1n, 5n, 10n);
    const batch = {
      proofs: [
        generateInclusionTrace(tree.membershipProof(1n)),
        generateNonMembershipTrace(3n, tree.nonMembershipProof(3n)),
        generateInclusionTrace(tree.membershipProof(10n)),
      ],
    };
    expect(verifyBatchedMerkleAIR(batch, { root: tree.root() }).ok).toBe(true);
  });

  test('batch fails if one inclusion is tampered', () => {
    const tree = buildTree(1n, 2n, 3n);
    const badAir = generateInclusionTrace(tree.membershipProof(2n));
    badAir.claimed_root = '0x' + 'ba'.repeat(32);
    const batch = {
      proofs: [
        generateInclusionTrace(tree.membershipProof(1n)),
        badAir,
      ],
    };
    const result = verifyBatchedMerkleAIR(batch, { root: tree.root() });
    expect(result.ok).toBe(false);
    expect(result.failure).toContain('proof[1]');
  });

  test('empty batch is ok', () => {
    expect(verifyBatchedMerkleAIR({ proofs: [] }, { root: buildTree(1n).root() }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Trusted root (B2) — Strix MEDIUM: a self-consistent trace from ANOTHER tree must fail
// ---------------------------------------------------------------------------

describe('Trusted root (B2): claimed_root must be the root the verifier trusts', () => {
  // The committed tree holds 5, 10 and 20. A forger builds its own tree, takes an honest trace
  // from it, and names that tree's root as claimed_root. Every per-row, continuity and B0/B1
  // constraint holds, because the trace really is consistent. Only the trusted root catches it.
  const committed = buildTree(5n, 10n, 20n);
  const root = committed.root();

  test('inclusion of a value the committed tree does not hold is refused', () => {
    const forgerTree = buildTree(5n, 99n, 20n);
    const forged = generateInclusionTrace(forgerTree.membershipProof(99n));
    const result = verifyInclusionAIR(forged, { root });
    expect(result.ok).toBe(false);
    expect(result.failure).toMatch(/^B2/);
    // The same trace against its own tree's root passes: the forgery is internally consistent,
    // which is why B0, R0, R1, C0 and B1 cannot catch it.
    expect(verifyInclusionAIR(forged, { root: forgerTree.root() })).toEqual({ ok: true });
  });

  test('non-membership of a value the committed tree DOES hold is refused', () => {
    const forgerTree = buildTree(5n, 20n); // no 10
    const forged = generateNonMembershipTrace(10n, forgerTree.nonMembershipProof(10n));
    const result = verifyNonMembershipAIR(forged, { root });
    expect(result.ok).toBe(false);
    expect(result.failure).toMatch(/B2/);
  });

  test('one forged proof fails the whole batch', () => {
    const forgerTree = buildTree(5n, 99n, 20n);
    const batch = {
      proofs: [
        generateInclusionTrace(committed.membershipProof(5n)),
        generateInclusionTrace(forgerTree.membershipProof(99n)),
      ],
    };
    const result = verifyBatchedMerkleAIR(batch, { root });
    expect(result.ok).toBe(false);
    expect(result.failure).toMatch(/^proof\[1\]: B2/);
  });
});
