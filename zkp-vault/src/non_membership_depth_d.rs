//! # Depth-D non-membership proof — prove `target ∉ Merkle_tree(root)` at arbitrary depth
//! (Item 14 step 14.0-d)
//!
//! Extends [`crate::non_membership`] (DEPTH=1 bundle) to a full D-level Merkle tree.
//!
//! ## What this proves
//!
//! A [`NonMembershipProofD`] bundles `1 + 2D` STARK proofs that together establish:
//!
//!   1. **Ordering**: `low_val < target < high_val` (from `ordering_check`, 14.0-a).
//!   2. **Low path**: D chained Merkle-path proofs (from `merkle_path`, 14.0-b) showing
//!      `low_val` is a member of the tree at `root`.
//!   3. **High path**: D chained Merkle-path proofs showing `high_val` is a member.
//!
//! ## Chain binding (cross-consistency)
//!
//! Each level k uses the output intermediate root from level k−1 as its leaf input and
//! the declared intermediate root from level k as its root public input.  The verifier:
//! - Recomputes all D intermediate roots off-circuit from the public witness.
//! - Verifies each sub-proof against those public inputs.
//! - Asserts the final intermediate root (level D−1) equals `stmt.root`.
//!
//! A forger cannot substitute any sub-proof without failing that level's STARK
//! verification, and cannot forge an intermediate root because it is a Poseidon2 hash
//! whose preimage is also proved in the adjacent level.
//!
//! ## HALF_P constraint (inherited from ordering_check)
//!
//! The ordering proof requires each of `target − low_val` and `high_val − target` to
//! be in `(0, HALF_P)`.  For sorted values spanning [0, 2^31), pairs more than `HALF_P`
//! apart need an intermediary — see `ordering_check` module header.
//!
//! ## Minimum tree depth
//!
//! D = 1 is supported (identical to [`crate::non_membership`] for single-level trees).

use p3_baby_bear::BabyBear;
use p3_field::{PrimeCharacteristicRing, PrimeField32};
use p3_uni_stark::Proof;

use crate::merkle_path::{
    merkle_parent, prove_merkle_path, verify_merkle_path, MerkleConfig,
};
use crate::ordering_check::{prove_ordering, verify_ordering, OrdConfig};

type Val = BabyBear;

fn v(x: u32) -> Val { Val::from_u64(u64::from(x)) }

// ---- Path primitives ---------------------------------------------------------

/// One step in a Merkle inclusion path.
#[derive(Clone, Debug)]
pub struct PathStep {
    /// The sibling node at this level.
    pub sibling: u32,
    /// `false` = the current node is the left child; `true` = it is the right child.
    pub direction: bool,
}

/// A depth-D Merkle inclusion path from `leaf` to a root.
#[derive(Clone, Debug)]
pub struct MerklePathD {
    /// The leaf value (the actual member being proved in the tree).
    pub leaf: u32,
    /// `steps[0]` is the leaf level (closest to leaf), `steps[D-1]` is closest to root.
    pub steps: Vec<PathStep>,
}

impl MerklePathD {
    /// Compute the intermediate root produced at each level, ending with the claimed root.
    ///
    /// Returns a Vec of length D.  `intermediates[k]` is the root output of level k
    /// (i.e. the parent hash of the current node and its sibling at that level).
    pub fn intermediate_roots(&self) -> Vec<u32> {
        let mut current = v(self.leaf);
        let mut roots = Vec::with_capacity(self.steps.len());
        for step in &self.steps {
            let parent = merkle_parent(current, v(step.sibling), step.direction);
            roots.push(parent.as_canonical_u32());
            current = parent;
        }
        roots
    }

    /// The root this path asserts (the last intermediate root).
    pub fn asserted_root(&self) -> u32 {
        self.intermediate_roots()
            .last()
            .copied()
            .expect("MerklePathD must have at least one step")
    }
}

// ---- Public API types --------------------------------------------------------

/// All inputs required to generate a depth-D non-membership proof.
pub struct NonMembershipWitnessD {
    /// The value claimed to be absent from the Merkle tree.
    pub target: u32,
    /// Depth-D Merkle inclusion path for `low_val` (immediately below `target`).
    pub low_path: MerklePathD,
    /// Depth-D Merkle inclusion path for `high_val` (immediately above `target`).
    pub high_path: MerklePathD,
}

/// Public statement — everything the verifier needs.
pub struct NonMembershipStatementD {
    /// The value claimed absent.
    pub target: u32,
    /// The committed Merkle root.
    pub root: u32,
    /// Depth-D path for `low_val`.
    pub low_path: MerklePathD,
    /// Depth-D path for `high_val`.
    pub high_path: MerklePathD,
}

/// `1 + 2D` STARK proofs establishing `target ∉ Merkle_tree(root)` at depth D.
pub struct NonMembershipProofD {
    /// Ordering proof: `low_val < target < high_val`.
    pub ordering: Proof<OrdConfig>,
    /// D Merkle-path proofs for `low_val`, level 0 (leaf) through D−1 (root).
    pub low_proofs: Vec<Proof<MerkleConfig>>,
    /// D Merkle-path proofs for `high_val`, level 0 (leaf) through D−1 (root).
    pub high_proofs: Vec<Proof<MerkleConfig>>,
}

/// Error returned by [`verify_non_membership_d`].
#[derive(Debug)]
pub enum NonMembershipErrorD {
    RootMismatch,
    PathDepthMismatch,
    OrderingFailed,
    LowPathFailed { level: usize },
    HighPathFailed { level: usize },
}

impl core::fmt::Display for NonMembershipErrorD {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::RootMismatch => write!(f, "low and high paths assert different roots"),
            Self::PathDepthMismatch => write!(f, "proof depth does not match statement path depth"),
            Self::OrderingFailed => write!(f, "ordering proof failed"),
            Self::LowPathFailed { level } => write!(f, "low-path failed at level {level}"),
            Self::HighPathFailed { level } => write!(f, "high-path failed at level {level}"),
        }
    }
}

// ---- Helper: prove a single depth-D path ------------------------------------

fn prove_path_d(path: &MerklePathD) -> Vec<Proof<MerkleConfig>> {
    let intermediates = path.intermediate_roots();
    let mut proofs = Vec::with_capacity(path.steps.len());
    let mut current = v(path.leaf);
    for (k, step) in path.steps.iter().enumerate() {
        let declared_root = v(intermediates[k]);
        proofs.push(prove_merkle_path(current, v(step.sibling), step.direction, declared_root));
        current = declared_root;
    }
    proofs
}

// ---- Prove / Verify ----------------------------------------------------------

/// Prove `target ∉ Merkle_tree(root)` at depth D.
///
/// Panics if:
/// - Either path has zero steps.
/// - Low and high paths assert different roots.
/// - `target` is not strictly between `low_val` and `high_val`.
pub fn prove_non_membership_d(w: &NonMembershipWitnessD) -> NonMembershipProofD {
    assert!(!w.low_path.steps.is_empty(), "path must have at least one step");
    assert!(!w.high_path.steps.is_empty(), "path must have at least one step");

    let low_root = w.low_path.asserted_root();
    let high_root = w.high_path.asserted_root();
    assert_eq!(low_root, high_root, "low and high paths must assert the same root");

    let low_val = w.low_path.leaf;
    let high_val = w.high_path.leaf;

    NonMembershipProofD {
        ordering: prove_ordering(low_val, w.target, high_val),
        low_proofs:  prove_path_d(&w.low_path),
        high_proofs: prove_path_d(&w.high_path),
    }
}

/// Verify a depth-D non-membership proof against a public statement.
///
/// Returns `Ok(())` iff all `1 + 2D` sub-proofs verify and cross-consistency holds.
pub fn verify_non_membership_d(
    proof: &NonMembershipProofD,
    stmt: &NonMembershipStatementD,
) -> Result<(), NonMembershipErrorD> {
    let d_low  = stmt.low_path.steps.len();
    let d_high = stmt.high_path.steps.len();
    if proof.low_proofs.len() != d_low || proof.high_proofs.len() != d_low {
        return Err(NonMembershipErrorD::PathDepthMismatch);
    }
    if proof.high_proofs.len() != d_high {
        return Err(NonMembershipErrorD::PathDepthMismatch);
    }

    let low_val  = stmt.low_path.leaf;
    let high_val = stmt.high_path.leaf;

    // Ordering
    verify_ordering(&proof.ordering, low_val, stmt.target, high_val)
        .map_err(|_| NonMembershipErrorD::OrderingFailed)?;

    // Low path: verify each level
    let low_irs = stmt.low_path.intermediate_roots();
    let mut current = v(low_val);
    for (k, step) in stmt.low_path.steps.iter().enumerate() {
        let declared_root = v(low_irs[k]);
        verify_merkle_path(&proof.low_proofs[k], current, v(step.sibling), step.direction, declared_root)
            .map_err(|_| NonMembershipErrorD::LowPathFailed { level: k })?;
        current = declared_root;
    }
    // Check the final root matches the statement
    if current.as_canonical_u32() != stmt.root {
        return Err(NonMembershipErrorD::LowPathFailed { level: d_low - 1 });
    }

    // High path: verify each level
    let high_irs = stmt.high_path.intermediate_roots();
    let mut current = v(high_val);
    for (k, step) in stmt.high_path.steps.iter().enumerate() {
        let declared_root = v(high_irs[k]);
        verify_merkle_path(&proof.high_proofs[k], current, v(step.sibling), step.direction, declared_root)
            .map_err(|_| NonMembershipErrorD::HighPathFailed { level: k })?;
        current = declared_root;
    }
    if current.as_canonical_u32() != stmt.root {
        return Err(NonMembershipErrorD::HighPathFailed { level: d_high - 1 });
    }

    Ok(())
}

// ---- Tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use p3_field::{PrimeCharacteristicRing, PrimeField32};
    use std::time::Instant;

    // Depth-2 tree with 4 leaves: [10, 20, 30, 40] (sorted)
    //
    //       root
    //      /    \
    //   ir_l   ir_r
    //   /  \   /  \
    //  10  20 30  40
    //
    // ir_l = H_p2(10, 20)  [10 is left child, dir=false; 20 is right child, dir=true]
    // ir_r = H_p2(30, 40)  [30 is left child, dir=false; 40 is right child, dir=true]
    // root = H_p2(ir_l, ir_r) [ir_l left, ir_r right]
    //
    // Target = 25 — lies strictly between 20 and 30.
    // low_val = 20: steps = [level0: sib=10, dir=true → ir_l], [level1: sib=ir_r, dir=false → root]
    // high_val = 30: steps = [level0: sib=40, dir=false → ir_r], [level1: sib=ir_l, dir=true → root]

    fn fv(x: u32) -> Val { Val::from_u64(u64::from(x)) }
    fn u32v(x: Val) -> u32 { x.as_canonical_u32() }

    fn tree_values() -> (u32, u32, u32) {
        let ir_l = u32v(merkle_parent(fv(10), fv(20), false)); // 10 is left child
        let ir_r = u32v(merkle_parent(fv(30), fv(40), false)); // 30 is left child
        let root = u32v(merkle_parent(fv(ir_l), fv(ir_r), false)); // ir_l is left child
        (ir_l, ir_r, root)
    }

    fn valid_witness() -> NonMembershipWitnessD {
        let (ir_l, ir_r, root) = tree_values();
        let _ = root; // used via asserted_root
        NonMembershipWitnessD {
            target: 25,
            low_path: MerklePathD {
                leaf: 20, // right child of ir_l (20 is right child → direction=true)
                steps: vec![
                    PathStep { sibling: 10, direction: true },  // level 0: H_p2(10,20)=ir_l
                    PathStep { sibling: ir_r, direction: false }, // level 1: H_p2(ir_l,ir_r)=root
                ],
            },
            high_path: MerklePathD {
                leaf: 30, // left child of ir_r (30 is left child → direction=false)
                steps: vec![
                    PathStep { sibling: 40, direction: false }, // level 0: H_p2(30,40)=ir_r
                    PathStep { sibling: ir_l, direction: true }, // level 1: H_p2(ir_l,ir_r)=root
                ],
            },
        }
    }

    fn valid_stmt() -> NonMembershipStatementD {
        let (_, _, root) = tree_values();
        let w = valid_witness();
        NonMembershipStatementD {
            target: w.target,
            root,
            low_path: w.low_path,
            high_path: w.high_path,
        }
    }

    // GATE 0: depth-2 valid non-membership proves and verifies end-to-end.
    #[test]
    fn valid_depth2_proves_and_verifies() {
        let t = Instant::now();
        let proof = prove_non_membership_d(&valid_witness());
        println!("prove_non_membership_d (D=2): {:?}", t.elapsed());
        let t = Instant::now();
        verify_non_membership_d(&proof, &valid_stmt()).expect("valid depth-2 non-membership must verify");
        println!("verify_non_membership_d (D=2): {:?}", t.elapsed());
    }

    // GATE 1: ordering violated (target == low_val) → prover panics.
    #[test]
    #[should_panic]
    fn target_equals_low_panics() {
        let mut w = valid_witness();
        w.target = w.low_path.leaf;
        prove_non_membership_d(&w);
    }

    // GATE 2: ordering violated (target == high_val) → prover panics.
    #[test]
    #[should_panic]
    fn target_equals_high_panics() {
        let mut w = valid_witness();
        w.target = w.high_path.leaf;
        prove_non_membership_d(&w);
    }

    // GATE 3: mismatched roots (tampered low_path) → prover panics.
    #[test]
    #[should_panic]
    fn mismatched_roots_panics() {
        let mut w = valid_witness();
        // Swap the level-1 sibling for low_path, breaking root consistency.
        w.low_path.steps[1].sibling = 999;
        prove_non_membership_d(&w);
    }

    // GATE 4: wrong target in statement → ordering proof bound to different target → fails.
    #[test]
    fn wrong_target_rejected() {
        let proof = prove_non_membership_d(&valid_witness());
        let mut stmt = valid_stmt();
        stmt.target = 28;
        assert!(verify_non_membership_d(&proof, &stmt).is_err());
    }

    // GATE 5: wrong root in statement → path final root check fails.
    #[test]
    fn wrong_root_rejected() {
        let proof = prove_non_membership_d(&valid_witness());
        let mut stmt = valid_stmt();
        stmt.root = 0;
        assert!(verify_non_membership_d(&proof, &stmt).is_err());
    }

    // GATE 6: wrong low_val (stmt mismatch) → ordering proof fails.
    #[test]
    fn wrong_low_val_rejected() {
        let proof = prove_non_membership_d(&valid_witness());
        let mut stmt = valid_stmt();
        stmt.low_path.leaf = 15; // ordering proof bound to low_val=20
        assert!(verify_non_membership_d(&proof, &stmt).is_err());
    }

    // GATE 7: wrong sibling in stmt (level 0 of low path) → merkle proof fails.
    #[test]
    fn wrong_low_level0_sibling_rejected() {
        let proof = prove_non_membership_d(&valid_witness());
        let mut stmt = valid_stmt();
        stmt.low_path.steps[0].sibling = 999;
        assert!(verify_non_membership_d(&proof, &stmt).is_err());
    }

    // GATE 8: depth-1 path (D=1) works correctly (regression: D=1 equals depth-1 bundle behavior).
    #[test]
    fn depth1_works() {
        use crate::merkle_path::merkle_parent;
        use crate::non_membership::{
            NonMembershipWitness, NonMembershipStatement,
            prove_non_membership, verify_non_membership,
        };
        // Build a minimal D=1 tree: leaves 10 and 30, root = H_p2(10,30)
        let root1 = merkle_parent(fv(10), fv(30), false).as_canonical_u32();
        // Prove using depth-D API with D=1
        let w_d = NonMembershipWitnessD {
            target: 20,
            low_path: MerklePathD {
                leaf: 10,
                steps: vec![PathStep { sibling: 30, direction: false }],
            },
            high_path: MerklePathD {
                leaf: 30,
                steps: vec![PathStep { sibling: 10, direction: true }],
            },
        };
        let proof_d = prove_non_membership_d(&w_d);
        let stmt_d = NonMembershipStatementD {
            target: 20,
            root: root1,
            low_path: w_d.low_path.clone(),
            high_path: w_d.high_path.clone(),
        };
        verify_non_membership_d(&proof_d, &stmt_d).expect("D=1 depth-D API must work");

        // Also verify the depth-1 bundle gives the same root
        let w1 = NonMembershipWitness {
            target: 20, low_val: 10, high_val: 30,
            low_sibling: 30, low_direction: false,
            high_sibling: 10, high_direction: true,
            root: root1,
        };
        let proof1 = prove_non_membership(&w1);
        let stmt1 = NonMembershipStatement {
            target: 20, low_val: 10, high_val: 30,
            low_sibling: 30, low_direction: false,
            high_sibling: 10, high_direction: true,
            root: root1,
        };
        verify_non_membership(&proof1, &stmt1).expect("D=1 bundle must still work");
    }

    // GATE 9: bench — exercises all 5 proof systems (1 ordering + 4 Merkle proofs).
    #[test]
    fn bench_depth2_bundle() {
        let t = Instant::now();
        let proof = prove_non_membership_d(&valid_witness());
        let prove_time = t.elapsed();
        let t = Instant::now();
        verify_non_membership_d(&proof, &valid_stmt()).unwrap();
        let verify_time = t.elapsed();
        println!("D=2: prove={prove_time:?}, verify={verify_time:?} (5 STARK proofs total)");
    }
}
