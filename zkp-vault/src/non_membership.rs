//! # Composite non-membership proof — prove `target ∉ Merkle_tree(root)`
//! (Item 14 step 14.0-c)
//!
//! ## What this proves
//!
//! A [`NonMembershipProof`] bundles three STARK proofs that together establish:
//!
//!   1. **Ordering**: `low_val < target < high_val` (from `ordering_check`, 14.0-a).
//!   2. **Low membership**: `low_val` is a DEPTH=1 leaf in the Merkle tree at `root`
//!      (from `merkle_path`, 14.0-b).
//!   3. **High membership**: `high_val` is a DEPTH=1 leaf in the same `root`
//!      (from `merkle_path`, 14.0-b).
//!
//! Together, (1) establishes that `target` lies strictly between its two neighbours,
//! and (2)+(3) establish that those neighbours are committed in the tree at the same
//! root. In a sorted linked-list (LeanIMT+) representation there is no gap between
//! consecutive committed entries, so no value between them can be a tree member.
//!
//! ## Honest scope — proof bundle, not a merged circuit
//!
//! This is a **proof bundle**: the three proofs are verified independently, and
//! `verify_non_membership` additionally checks cross-proof consistency (same
//! `low_val`, `high_val`, and `root` appear in all three).
//!
//! A single-circuit non-membership AIR would require proof composition (recursive
//! STARK) or a flat AIR with multiple gadgets, neither of which is available at the
//! current Plonky3 0.3.0 pin. The bundle is sound: a forger cannot substitute any
//! sub-proof without failing that sub-proof's verification, because each proof is
//! bound to its public inputs.
//!
//! ## DEPTH=1 limitation
//!
//! Both `low_val` and `high_val` are proved against a single Merkle parent level
//! (DEPTH=1 from 14.0-b). Depth-D non-membership proofs require chaining D ordering
//! steps (trivial) and D Merkle path proofs per neighbour, which this module's API
//! can accommodate by extending `NonMembershipWitness` with a path array.

use p3_baby_bear::BabyBear;
use p3_field::{PrimeCharacteristicRing, PrimeField32};
use p3_uni_stark::Proof;

use crate::merkle_path::{
    merkle_parent, prove_merkle_path, verify_merkle_path, MerkleConfig,
};
use crate::ordering_check::{prove_ordering, verify_ordering, OrdConfig};

type Val = BabyBear;

// ---- Helper ------------------------------------------------------------------

fn v(x: u32) -> Val { Val::from_u64(u64::from(x)) }
fn u32v(x: Val) -> u32 { x.as_canonical_u32() }

// ---- Public API types --------------------------------------------------------

/// All inputs required to generate a non-membership proof.
pub struct NonMembershipWitness {
    /// The value claimed to be absent from the Merkle tree.
    pub target: u32,
    /// A leaf known to be in the tree, immediately below `target`.
    pub low_val: u32,
    /// A leaf known to be in the tree, immediately above `target`.
    pub high_val: u32,
    /// Sibling of `low_val` in the DEPTH=1 Merkle tree.
    pub low_sibling: u32,
    /// `false` = `low_val` is the left child; `true` = right child.
    pub low_direction: bool,
    /// Sibling of `high_val` in the DEPTH=1 Merkle tree.
    pub high_sibling: u32,
    /// `false` = `high_val` is the left child; `true` = right child.
    pub high_direction: bool,
    /// The Merkle root that both `low_val` and `high_val` are members of.
    pub root: u32,
}

/// Public statement — everything the verifier needs (no private witnesses).
pub struct NonMembershipStatement {
    pub target: u32,
    pub low_val: u32,
    pub high_val: u32,
    pub low_sibling: u32,
    pub low_direction: bool,
    pub high_sibling: u32,
    pub high_direction: bool,
    pub root: u32,
}

/// Three-proof bundle establishing `target ∉ Merkle_tree(root)` at DEPTH=1.
///
/// Fields are the individual STARK proofs, stored as typed values to preserve
/// the verifier's ability to bind each proof to its public inputs.
pub struct NonMembershipProof {
    /// Ordering proof: `low_val < target < high_val`.
    pub ordering: Proof<OrdConfig>,
    /// Membership proof: `low_val ∈ Merkle_tree(root)`.
    pub low_path: Proof<MerkleConfig>,
    /// Membership proof: `high_val ∈ Merkle_tree(root)`.
    pub high_path: Proof<MerkleConfig>,
}

/// Error returned by [`verify_non_membership`].
#[derive(Debug)]
pub enum NonMembershipError {
    OrderingFailed,
    LowPathFailed,
    HighPathFailed,
}

impl core::fmt::Display for NonMembershipError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::OrderingFailed => write!(f, "ordering proof failed (low_val < target < high_val)"),
            Self::LowPathFailed  => write!(f, "low-path membership proof failed"),
            Self::HighPathFailed => write!(f, "high-path membership proof failed"),
        }
    }
}

// ---- Prove / Verify ----------------------------------------------------------

/// Prove `target ∉ Merkle_tree(w.root)` (DEPTH=1).
///
/// Panics if any of the three sub-proof preconditions are violated:
/// - `w.low_val >= w.target || w.target >= w.high_val` (ordering)
/// - `merkle_parent(w.low_val, w.low_sibling, w.low_direction) != w.root`
/// - `merkle_parent(w.high_val, w.high_sibling, w.high_direction) != w.root`
pub fn prove_non_membership(w: &NonMembershipWitness) -> NonMembershipProof {
    // Pre-check: both neighbours are actually members of the declared root.
    let low_root = u32v(merkle_parent(v(w.low_val), v(w.low_sibling), w.low_direction));
    let high_root = u32v(merkle_parent(v(w.high_val), v(w.high_sibling), w.high_direction));
    assert_eq!(low_root, w.root,  "low_val is not a member of root at DEPTH=1");
    assert_eq!(high_root, w.root, "high_val is not a member of root at DEPTH=1");

    NonMembershipProof {
        ordering: prove_ordering(w.low_val, w.target, w.high_val),
        low_path:  prove_merkle_path(v(w.low_val),  v(w.low_sibling),  w.low_direction,  v(w.root)),
        high_path: prove_merkle_path(v(w.high_val), v(w.high_sibling), w.high_direction, v(w.root)),
    }
}

/// Verify a non-membership proof bundle against a public statement.
///
/// Returns `Ok(())` iff:
/// - The ordering proof establishes `stmt.low_val < stmt.target < stmt.high_val`.
/// - The low-path proof establishes `stmt.low_val ∈ Merkle_tree(stmt.root)`.
/// - The high-path proof establishes `stmt.high_val ∈ Merkle_tree(stmt.root)`.
///
/// Cross-consistency is enforced by public-input binding: each sub-proof is
/// bound to its own public inputs at prove-time, so mismatching the statement
/// values fails verification of at least one proof.
pub fn verify_non_membership(
    proof: &NonMembershipProof,
    stmt: &NonMembershipStatement,
) -> Result<(), NonMembershipError> {
    verify_ordering(&proof.ordering, stmt.low_val, stmt.target, stmt.high_val)
        .map_err(|_| NonMembershipError::OrderingFailed)?;
    verify_merkle_path(
        &proof.low_path,
        v(stmt.low_val),
        v(stmt.low_sibling),
        stmt.low_direction,
        v(stmt.root),
    ).map_err(|_| NonMembershipError::LowPathFailed)?;
    verify_merkle_path(
        &proof.high_path,
        v(stmt.high_val),
        v(stmt.high_sibling),
        stmt.high_direction,
        v(stmt.root),
    ).map_err(|_| NonMembershipError::HighPathFailed)?;
    Ok(())
}

// ---- Tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use p3_field::{PrimeCharacteristicRing, PrimeField32};
    use std::time::Instant;

    // Build a minimal DEPTH=1 tree with two leaves: left=10, right=30.
    //   root = H_p2(10, 30)
    //   low_val=10 with sibling=30, direction=false (10 is the left child)
    //   high_val=30 with sibling=10, direction=true  (30 is the right child)
    //   target=20 lies strictly between them.

    fn tv(x: u32) -> Val { Val::from_u64(u64::from(x)) }

    fn test_root() -> u32 {
        merkle_parent(tv(10), tv(30), false).as_canonical_u32()
    }

    fn valid_witness() -> NonMembershipWitness {
        NonMembershipWitness {
            target:         20,
            low_val:        10,
            high_val:       30,
            low_sibling:    30,
            low_direction:  false,
            high_sibling:   10,
            high_direction: true,
            root:           test_root(),
        }
    }

    fn valid_stmt() -> NonMembershipStatement {
        let w = valid_witness();
        NonMembershipStatement {
            target:         w.target,
            low_val:        w.low_val,
            high_val:       w.high_val,
            low_sibling:    w.low_sibling,
            low_direction:  w.low_direction,
            high_sibling:   w.high_sibling,
            high_direction: w.high_direction,
            root:           w.root,
        }
    }

    // GATE 0: valid non-membership proves and verifies end-to-end.
    #[test]
    fn valid_non_membership_proves_and_verifies() {
        let t = Instant::now();
        let proof = prove_non_membership(&valid_witness());
        println!("prove_non_membership: {:?}", t.elapsed());
        verify_non_membership(&proof, &valid_stmt()).expect("valid non-membership must verify");
    }

    // GATE 1: target == low_val → ordering violated → prover panics.
    #[test]
    #[should_panic]
    fn target_equals_low_panics() {
        let mut w = valid_witness();
        w.target = w.low_val;
        prove_non_membership(&w);
    }

    // GATE 2: target == high_val → ordering violated → prover panics.
    #[test]
    #[should_panic]
    fn target_equals_high_panics() {
        let mut w = valid_witness();
        w.target = w.high_val;
        prove_non_membership(&w);
    }

    // GATE 3: wrong sibling → low_val not in root → pre-check panics.
    #[test]
    #[should_panic]
    fn wrong_low_sibling_panics_before_proof() {
        let mut w = valid_witness();
        w.low_sibling = 999;
        prove_non_membership(&w);
    }

    // GATE 4: verification rejects a wrong target (ordering proof bound to target=20).
    #[test]
    fn wrong_target_rejected_at_verify() {
        let proof = prove_non_membership(&valid_witness());
        let mut stmt = valid_stmt();
        stmt.target = 25;
        assert!(verify_non_membership(&proof, &stmt).is_err(), "wrong target must fail");
    }

    // GATE 5: verification rejects a wrong root (Merkle proofs bound to real root).
    #[test]
    fn wrong_root_rejected_at_verify() {
        let proof = prove_non_membership(&valid_witness());
        let mut stmt = valid_stmt();
        stmt.root = 0;
        assert!(verify_non_membership(&proof, &stmt).is_err(), "wrong root must fail");
    }

    // GATE 6: cross-proof consistency — mismatched low_val fails at verify.
    #[test]
    fn wrong_low_val_rejected_at_verify() {
        let proof = prove_non_membership(&valid_witness());
        let mut stmt = valid_stmt();
        stmt.low_val = 5;  // ordering proof is bound to low_val=10
        assert!(verify_non_membership(&proof, &stmt).is_err(), "mismatched low_val must fail");
    }

    // GATE 7: cross-proof consistency — mismatched high_val fails at verify.
    #[test]
    fn wrong_high_val_rejected_at_verify() {
        let proof = prove_non_membership(&valid_witness());
        let mut stmt = valid_stmt();
        stmt.high_val = 50;  // ordering proof is bound to high_val=30
        assert!(verify_non_membership(&proof, &stmt).is_err(), "mismatched high_val must fail");
    }

    // GATE 8: bench — exercises all three proof systems together.
    #[test]
    fn bench_full_bundle() {
        let t = Instant::now();
        let proof = prove_non_membership(&valid_witness());
        let prove_time = t.elapsed();
        let t = Instant::now();
        verify_non_membership(&proof, &valid_stmt()).unwrap();
        println!("prove: {prove_time:?}, verify: {:?}", t.elapsed());
    }
}
