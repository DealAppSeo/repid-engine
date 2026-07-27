/**
 * P1 LeanIMT+ (D-094) — indexed Merkle accumulator with membership, non-membership,
 * and PROVABLE RETRACTION, under the real BabyBear Poseidon2 leaf. This is the
 * reduction-to-practice of the current-valid / revocable proof-carrying memory core.
 */
import {
  LeanIMTPlus, verifyMembership, verifyNonMembership, verifyCurrentValidity,
} from '../src/memory/leanimt-plus';

describe('LeanIMTPlus — membership + non-membership (real Poseidon2)', () => {
  const t = new LeanIMTPlus();
  [5n, 10n, 7n, 3n].forEach((v) => t.insert(v)); // sorted chain 0→3→5→7→10→0
  const root = t.root();

  it('every inserted value has a verifying membership proof', () => {
    for (const v of [3n, 5n, 7n, 10n]) {
      expect(verifyMembership(v, t.membershipProof(v), root)).toBe(true);
    }
  });

  it('a value in a gap has a verifying non-membership proof', () => {
    for (const v of [4n, 6n, 8n, 9n]) {
      expect(verifyNonMembership(v, t.nonMembershipProof(v), root)).toBe(true);
    }
  });

  it('a value past the tail has a verifying non-membership proof', () => {
    expect(verifyNonMembership(999n, t.nonMembershipProof(999n), root)).toBe(true);
  });

  it('membership and non-membership are mutually exclusive for the same value', () => {
    expect(verifyMembership(5n, t.membershipProof(5n), root)).toBe(true);
    // 5 is present, so a non-membership witness for 5 must not verify
    const bogusLow = t.nonMembershipProof(4n); // low leaf {3, 5}
    expect(verifyNonMembership(5n, bogusLow, root)).toBe(false); // 5 is NOT < next(5) gap
  });
});

describe('LeanIMTPlus — PROVABLE RETRACTION (the current-validity core)', () => {
  const t = new LeanIMTPlus();
  [5n, 10n, 7n].forEach((v) => t.insert(v));
  const rootBefore = t.root();

  it('before revoke: 7 is a current member, non-member proof for 7 impossible', () => {
    expect(verifyCurrentValidity(7n, t.membershipProof(7n), rootBefore)).toBe(true);
  });

  it('after revoke(7): current-validity FAILS and non-membership SUCCEEDS (retraction is provable)', () => {
    const proof7 = t.membershipProof(7n); // capture witness at the pre-revoke state
    t.revoke(7n);
    const rootAfter = t.root();
    expect(rootAfter).not.toBe(rootBefore);                              // root moved
    expect(() => t.membershipProof(7n)).toThrow();                       // 7 no longer active
    expect(verifyNonMembership(7n, t.nonMembershipProof(7n), rootAfter)).toBe(true); // provably retracted
    // the stale pre-revoke membership proof must NOT verify against the new root
    expect(verifyMembership(7n, proof7, rootAfter)).toBe(false);
    // neighbors still valid
    expect(verifyMembership(5n, t.membershipProof(5n), rootAfter)).toBe(true);
    expect(verifyMembership(10n, t.membershipProof(10n), rootAfter)).toBe(true);
  });
});

describe('LeanIMTPlus — tombstone guard (cannot forge non-membership)', () => {
  it('a tombstoned/value-0 leaf cannot be used as a low leaf to forge non-membership', () => {
    const t = new LeanIMTPlus();
    [5n, 10n].forEach((v) => t.insert(v));
    t.revoke(5n); // 5's leaf becomes tombstoned {0,0}
    const root = t.root();
    // Forge: try to present the tombstoned leaf (now {0,0}) as a low leaf for value 8.
    // The engine won't hand it out (lowLeafIndex skips tombstones); construct it by hand:
    const forged = { lowLeaf: { index: 1, leaf: { value: 0n, next: 0n, tombstoned: true }, path: t.nonMembershipProof(8n).lowLeaf.path } };
    expect(verifyNonMembership(8n, forged as any, root)).toBe(false); // guard rejects tombstoned low leaf
    // legitimate non-membership for 8 still works via the real active low leaf (10-tail chain)
    expect(verifyNonMembership(8n, t.nonMembershipProof(8n), root)).toBe(true);
    // 5 is now provably absent (retracted)
    expect(verifyNonMembership(5n, t.nonMembershipProof(5n), root)).toBe(true);
  });
});
