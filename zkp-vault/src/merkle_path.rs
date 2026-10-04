//! # Merkle-path base case — prove one level of a Poseidon2 Merkle inclusion path
//! (Item 14 step 14.0-b)
//!
//! ## What this proves
//!
//! Given public inputs `(leaf, sibling, direction, root)`, the STARK proves in-circuit
//! that `H_p2(left, right) = root`, where:
//!
//! ```text
//! direction = 0:  left = leaf,    right = sibling
//! direction = 1:  left = sibling, right = leaf
//! ```
//!
//! This is the base case (DEPTH=1) of a Poseidon2 binary Merkle tree membership proof.
//!
//! ## Honest scope — DEPTH=1 only
//!
//! This module proves exactly one hash level. Depth-D paths require one of:
//!
//! - **Chaining D proofs** (serial composition): prove level 0 → root_0, then
//!   level 1 with leaf=root_0 → root_1, etc. Needs no new circuit capability
//!   but produces D separate proofs, not one.
//! - **Flat AIR** (D Poseidon2 gadgets in one wide row): feasible but requires
//!   extending the trace beyond the gadget's W columns, which collides with the
//!   `debug_assert` in `Borrow<P2Cols>` in the current Plonky3 0.3.0 pin. A future
//!   beat can build this once that constraint is understood or the API extended.
//! - **Proof composition** (recursive STARK): requires the `attempt_incircuit_verify`
//!   feature which intentionally fails to compile at this Plonky3 pin — not yet.
//!
//! ## Why direction is a public input (not private witness)
//!
//! Private direction would require an extra trace column (W+1 total), which triggers
//! the debug_assert. Making direction public means the verifier knows which side the
//! leaf is on; for the full non-membership AIR (14.0-c) privacy can be restored by
//! folding direction into the leaf-hash preimage instead of as a separate selector.
//!
//! ## Column layout
//!
//! Identical to `OwnershipAir` — exactly `W = num_cols::<P2_WIDTH, ...>()` columns,
//! all belonging to the Poseidon2Air gadget. No extra columns.
//!
//! ## Constraints (uniform, all rows identical)
//!
//! 1. Poseidon2 round constraints from the audited `Poseidon2Air` gadget.
//! 2. `direction * (1 − direction) = 0` (direction is binary).
//! 3. `inputs[0] = (1−direction) * leaf + direction * sibling` (left child from public inputs).
//! 4. `inputs[1] = direction * leaf + (1−direction) * sibling` (right child from public inputs).
//! 5. `inputs[lane] = 0` for `lane ∈ 2..P2_WIDTH` (zero-pad).
//! 6. `out0 = root` (the computed hash equals the declared root).

use core::borrow::Borrow;

use p3_air::{Air, AirBuilderWithPublicValues, BaseAir};
use p3_baby_bear::{
    BabyBear, GenericPoseidon2LinearLayersBabyBear, BABYBEAR_RC16_EXTERNAL_FINAL,
    BABYBEAR_RC16_EXTERNAL_INITIAL, BABYBEAR_RC16_INTERNAL,
};
use p3_challenger::{HashChallenger, SerializingChallenger32};
use p3_commit::ExtensionMmcs;
use p3_dft::Radix2DitParallel;
use p3_field::extension::BinomialExtensionField;
use p3_field::PrimeCharacteristicRing;
use p3_fri::{FriParameters, HidingFriPcs};
use p3_keccak::{Keccak256Hash, KeccakF};
use p3_matrix::dense::RowMajorMatrix;
use p3_matrix::Matrix;
use p3_merkle_tree::MerkleTreeHidingMmcs;
use p3_poseidon2::GenericPoseidon2LinearLayers;
use p3_poseidon2_air::{
    generate_trace_rows, num_cols, Poseidon2Air, Poseidon2Cols, RoundConstants,
};
use p3_symmetric::{CompressionFunctionFromHasher, PaddingFreeSponge, SerializingHasher};
use p3_uni_stark::{prove, verify, Proof, StarkConfig, VerificationError};
use rand::rngs::SmallRng;
use rand::SeedableRng;

use crate::poseidon2_hash2::h_p2_field;

// ---- BabyBear Poseidon2 parameters (identical to lib.rs) ---------------------

type Val = BabyBear;
type LinearLayers = GenericPoseidon2LinearLayersBabyBear;

const P2_WIDTH: usize = crate::P2_WIDTH;
const P2_SBOX_DEGREE: u64 = crate::P2_SBOX_DEGREE;
const P2_SBOX_REGISTERS: usize = crate::P2_SBOX_REGISTERS;
const P2_HALF_FULL_ROUNDS: usize = crate::P2_HALF_FULL_ROUNDS;
const P2_PARTIAL_ROUNDS: usize = crate::P2_PARTIAL_ROUNDS;

type P2Constants =
    RoundConstants<Val, P2_WIDTH, P2_HALF_FULL_ROUNDS, P2_PARTIAL_ROUNDS>;
type P2Air = Poseidon2Air<
    Val,
    LinearLayers,
    P2_WIDTH,
    P2_SBOX_DEGREE,
    P2_SBOX_REGISTERS,
    P2_HALF_FULL_ROUNDS,
    P2_PARTIAL_ROUNDS,
>;
type P2Cols<T> = Poseidon2Cols<
    T,
    P2_WIDTH,
    P2_SBOX_DEGREE,
    P2_SBOX_REGISTERS,
    P2_HALF_FULL_ROUNDS,
    P2_PARTIAL_ROUNDS,
>;

/// Trace width: the Poseidon2 gadget's column count exactly (no extra columns).
const W: usize = num_cols::<
    P2_WIDTH,
    P2_SBOX_DEGREE,
    P2_SBOX_REGISTERS,
    P2_HALF_FULL_ROUNDS,
    P2_PARTIAL_ROUNDS,
>();

/// Trace height. HEIGHT=8 rows (all identical), same as `OwnershipAir` and
/// `OrderingCheckAir`. The FRI floor is 4 at these params; 8 gives headroom.
const HEIGHT: usize = 8;

fn p2_round_constants() -> P2Constants {
    P2Constants::new(
        BABYBEAR_RC16_EXTERNAL_INITIAL,
        BABYBEAR_RC16_INTERNAL,
        BABYBEAR_RC16_EXTERNAL_FINAL,
    )
}

// ---- Plonky3 config (identical construction to lib.rs, seeded differently) ---

type Challenge = BinomialExtensionField<Val, 4>;
type ByteHash = Keccak256Hash;
type U64Hash = PaddingFreeSponge<KeccakF, 25, 17, 4>;
type FieldHash = SerializingHasher<U64Hash>;
type MyCompress = CompressionFunctionFromHasher<U64Hash, 2, 4>;
type ValHidingMmcs = MerkleTreeHidingMmcs<
    [Val; p3_keccak::VECTOR_LEN],
    [u64; p3_keccak::VECTOR_LEN],
    FieldHash,
    MyCompress,
    SmallRng,
    4,
    4,
>;
type ChallengeHidingMmcs = ExtensionMmcs<Val, Challenge, ValHidingMmcs>;
type Dft = Radix2DitParallel<Val>;
type Challenger = SerializingChallenger32<Val, HashChallenger<u8, ByteHash, 32>>;
type HidingPcs = HidingFriPcs<Val, Dft, ValHidingMmcs, ChallengeHidingMmcs, SmallRng>;
type MerkleConfig = StarkConfig<HidingPcs, Challenge, Challenger>;

fn make_config() -> MerkleConfig {
    let byte_hash = ByteHash {};
    let u64_hash = U64Hash::new(KeccakF {});
    let field_hash = FieldHash::new(u64_hash);
    let compress = MyCompress::new(u64_hash);
    // Seed differs from lib.rs (1) and ordering_check.rs (2) to avoid any accidental
    // cross-circuit proof reuse.
    let val_mmcs = ValHidingMmcs::new(field_hash, compress, SmallRng::seed_from_u64(3));
    let challenge_mmcs = ChallengeHidingMmcs::new(val_mmcs.clone());
    let dft = Dft::default();
    let fri_params = FriParameters {
        log_blowup: 3,
        log_final_poly_len: 2,
        num_queries: 2,
        proof_of_work_bits: 1,
        mmcs: challenge_mmcs,
    };
    let pcs = HidingFriPcs::new(dft, val_mmcs, fri_params, 4, SmallRng::seed_from_u64(3));
    let challenger = Challenger::from_hasher(vec![], byte_hash);
    MerkleConfig::new(pcs, challenger)
}

// ---- AIR ---------------------------------------------------------------------

/// Proves one level of a Poseidon2 Merkle inclusion path (DEPTH=1).
///
/// Public inputs (4 values): `[leaf, sibling, direction, root]`.
/// The AIR constrains that `H_p2(left, right) = root` where
/// `(left, right)` is selected by `direction` from `(leaf, sibling)`.
pub struct MerklePathAir {
    p2: P2Air,
}

impl MerklePathAir {
    pub fn new() -> Self {
        Self {
            p2: P2Air::new(p2_round_constants()),
        }
    }
}

impl Default for MerklePathAir {
    fn default() -> Self {
        Self::new()
    }
}

impl BaseAir<Val> for MerklePathAir {
    fn width(&self) -> usize {
        W
    }
}

impl<AB> Air<AB> for MerklePathAir
where
    AB: AirBuilderWithPublicValues<F = Val>,
    LinearLayers: GenericPoseidon2LinearLayers<AB::Expr, P2_WIDTH>,
{
    fn eval(&self, builder: &mut AB) {
        // 1. Poseidon2 round constraints — the audited gadget, applied to ALL rows.
        self.p2.eval(builder);

        // 2. Read public inputs: [leaf, sibling, direction, root].
        //    Copy scalars before any mutable borrow of `builder`.
        let (leaf_pv, sib_pv, dir_pv, root_pv) = {
            let pis = builder.public_values();
            (pis[0], pis[1], pis[2], pis[3])
        };
        let leaf: AB::Expr = leaf_pv.into();
        let sibling: AB::Expr = sib_pv.into();
        let dir: AB::Expr = dir_pv.into();
        let root: AB::Expr = root_pv.into();

        // 3. Read current row and extract owned lane expressions.
        let (inputs, out0) = {
            let main = builder.main();
            let row = main.row_slice(0).expect("trace has no rows");
            let cols: &P2Cols<AB::Var> = (*row).borrow();
            let inputs: Vec<AB::Expr> = cols.inputs.iter().map(|v| (*v).into()).collect();
            let out0: AB::Expr =
                cols.ending_full_rounds[P2_HALF_FULL_ROUNDS - 1].post[0].into();
            (inputs, out0)
        };

        // 4. Binary direction constraint.
        builder.assert_zero(dir.clone() * (AB::Expr::ONE - dir.clone()));

        // 5. Left-child assignment: inputs[0] = (1−dir)*leaf + dir*sibling.
        let expected_left =
            (AB::Expr::ONE - dir.clone()) * leaf.clone() + dir.clone() * sibling.clone();
        builder.assert_eq(inputs[0].clone(), expected_left);

        // 6. Right-child assignment: inputs[1] = dir*leaf + (1−dir)*sibling.
        let expected_right =
            dir.clone() * leaf + (AB::Expr::ONE - dir) * sibling;
        builder.assert_eq(inputs[1].clone(), expected_right);

        // 7. Zero-pad lanes 2..P2_WIDTH.
        for lane in 2..P2_WIDTH {
            builder.assert_zero(inputs[lane].clone());
        }

        // 8. Root constraint: the permutation output equals the declared root.
        builder.assert_eq(out0, root);
    }
}

// ---- Witness generation ------------------------------------------------------

/// Compute `(left, right)` from `(leaf, sibling, direction)`.
///
/// - `direction = false` (0): `left = leaf`, `right = sibling`.
/// - `direction = true`  (1): `left = sibling`, `right = leaf`.
fn lr(leaf: Val, sibling: Val, direction: bool) -> (Val, Val) {
    if direction {
        (sibling, leaf)
    } else {
        (leaf, sibling)
    }
}

/// Compute the Poseidon2 Merkle parent: `H_p2(left, right)`.
pub fn merkle_parent(leaf: Val, sibling: Val, direction: bool) -> Val {
    let (left, right) = lr(leaf, sibling, direction);
    h_p2_field(left, right)
}

/// Encode `direction` as a BabyBear field element (0 or 1).
fn dir_field(direction: bool) -> Val {
    Val::from_u64(u64::from(direction))
}

/// Generate the proof trace: HEIGHT rows, all identical (the single H_p2 computation).
fn generate_trace(leaf: Val, sibling: Val, direction: bool) -> RowMajorMatrix<Val> {
    let (left, right) = lr(leaf, sibling, direction);
    let mut lanes = [Val::ZERO; P2_WIDTH];
    lanes[0] = left;
    lanes[1] = right;
    let inputs = vec![lanes; HEIGHT];
    generate_trace_rows::<
        Val,
        LinearLayers,
        P2_WIDTH,
        P2_SBOX_DEGREE,
        P2_SBOX_REGISTERS,
        P2_HALF_FULL_ROUNDS,
        P2_PARTIAL_ROUNDS,
    >(inputs, &p2_round_constants(), 0)
}

fn public_values(leaf: Val, sibling: Val, direction: bool, root: Val) -> Vec<Val> {
    vec![leaf, sibling, dir_field(direction), root]
}

/// Prove that `H_p2(left, right) = root` where `(left, right)` is derived
/// from `(leaf, sibling, direction)`.
///
/// `root` must equal `merkle_parent(leaf, sibling, direction)`; otherwise
/// the prover panics in debug mode or generates an invalid proof.
pub fn prove_merkle_path(
    leaf: Val,
    sibling: Val,
    direction: bool,
    root: Val,
) -> Proof<MerkleConfig> {
    let config = make_config();
    let trace = generate_trace(leaf, sibling, direction);
    prove(
        &config,
        &MerklePathAir::new(),
        trace,
        &public_values(leaf, sibling, direction, root),
    )
}

/// Verify a Merkle-path proof.
///
/// The verifier learns `(leaf, sibling, direction, root)` — all public inputs.
/// The proof attests that the prover computed `H_p2(left, right) = root`
/// in-circuit using the Poseidon2 AIR.
pub fn verify_merkle_path(
    proof: &Proof<MerkleConfig>,
    leaf: Val,
    sibling: Val,
    direction: bool,
    root: Val,
) -> Result<(), VerificationError<impl core::fmt::Debug>> {
    let config = make_config();
    verify(
        &config,
        &MerklePathAir::new(),
        proof,
        &public_values(leaf, sibling, direction, root),
    )
}

pub fn proof_to_bytes(proof: &Proof<MerkleConfig>) -> Vec<u8> {
    bincode::serialize(proof).expect("proof serialization")
}

pub fn proof_from_bytes(bytes: &[u8]) -> Result<Proof<MerkleConfig>, bincode::Error> {
    bincode::deserialize(bytes)
}

// ---- Tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use p3_field::PrimeField32;
    use std::time::Instant;

    // Fixed test values — small BabyBear field elements.
    const LEAF: u32 = 42;
    const SIBLING: u32 = 137;

    fn leaf_val() -> Val { Val::from_u64(u64::from(LEAF)) }
    fn sib_val() -> Val { Val::from_u64(u64::from(SIBLING)) }

    // GATE 0 — off-circuit and in-circuit agree.
    //
    // The most critical gate: if the prover's trace computes a DIFFERENT hash than
    // `h_p2_field`, a proof would verify against its own trace while the off-circuit
    // root commitment would diverge. Catches any drift in lane convention or constants.
    #[test]
    fn in_circuit_matches_off_circuit() {
        for direction in [false, true] {
            let leaf = leaf_val();
            let sib = sib_val();
            let root = merkle_parent(leaf, sib, direction);

            // Read the COMMITTED trace and check the output lane directly.
            let trace = generate_trace(leaf, sib, direction);
            let row = trace.row_slice(0).expect("row");
            let cols: &P2Cols<Val> = (*row).borrow();
            let in_circuit_out = cols.ending_full_rounds[P2_HALF_FULL_ROUNDS - 1].post[0];

            assert_eq!(
                in_circuit_out, root,
                "in-circuit output != off-circuit merkle_parent for direction={direction}"
            );
        }
    }

    // GATE 1a — direction=0: leaf is left child, sibling is right.
    #[test]
    fn valid_path_dir0_proves_and_verifies() {
        let leaf = leaf_val();
        let sib = sib_val();
        let root = merkle_parent(leaf, sib, false);
        let proof = prove_merkle_path(leaf, sib, false, root);
        verify_merkle_path(&proof, leaf, sib, false, root)
            .expect("valid dir=0 path must verify");
    }

    // GATE 1b — direction=1: sibling is left child, leaf is right.
    #[test]
    fn valid_path_dir1_proves_and_verifies() {
        let leaf = leaf_val();
        let sib = sib_val();
        let root = merkle_parent(leaf, sib, true);
        let proof = prove_merkle_path(leaf, sib, true, root);
        verify_merkle_path(&proof, leaf, sib, true, root)
            .expect("valid dir=1 path must verify");
    }

    // GATE 2a — wrong root is rejected.
    #[test]
    fn wrong_root_rejected() {
        let leaf = leaf_val();
        let sib = sib_val();
        let root = merkle_parent(leaf, sib, false);
        let proof = prove_merkle_path(leaf, sib, false, root);
        let wrong_root = root + Val::ONE;
        assert!(
            verify_merkle_path(&proof, leaf, sib, false, wrong_root).is_err(),
            "wrong root must not verify"
        );
    }

    // GATE 2b — wrong sibling is rejected.
    //
    // If the claimed sibling is wrong, the public inputs don't match the committed
    // trace (which used the original sibling). The verifier rejects.
    #[test]
    fn wrong_sibling_rejected() {
        let leaf = leaf_val();
        let sib = sib_val();
        let root = merkle_parent(leaf, sib, false);
        let proof = prove_merkle_path(leaf, sib, false, root);
        let wrong_sib = sib + Val::ONE;
        // The proof was generated with the original sibling; claiming a different one
        // means the public inputs don't match the committed left/right assignment.
        assert!(
            verify_merkle_path(&proof, leaf, wrong_sib, false, root).is_err(),
            "wrong sibling must not verify"
        );
    }

    // GATE 2c — wrong direction is rejected.
    //
    // Flipping direction changes (left, right) from (leaf, sib) to (sib, leaf),
    // producing a different H_p2 output. The root in public inputs won't match.
    #[test]
    fn wrong_direction_rejected() {
        let leaf = leaf_val();
        let sib = sib_val();
        // Prove with direction=false; claim direction=true on verify.
        let root = merkle_parent(leaf, sib, false);
        let proof = prove_merkle_path(leaf, sib, false, root);
        assert!(
            verify_merkle_path(&proof, leaf, sib, true, root).is_err(),
            "wrong direction must not verify"
        );
    }

    // GATE 3 — tampered proof is rejected.
    #[test]
    fn tampered_proof_rejected() {
        let leaf = leaf_val();
        let sib = sib_val();
        let root = merkle_parent(leaf, sib, false);
        let proof = prove_merkle_path(leaf, sib, false, root);
        let mut bytes = proof_to_bytes(&proof);
        verify_merkle_path(&proof_from_bytes(&bytes).unwrap(), leaf, sib, false, root)
            .expect("clean round-trip verifies");
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xFF;
        let rejected = match proof_from_bytes(&bytes) {
            Err(_) => true,
            Ok(t) => verify_merkle_path(&t, leaf, sib, false, root).is_err(),
        };
        assert!(rejected, "tampered proof must be rejected");
    }

    // GATE 4 — different (leaf, sib, dir) triples give different roots.
    //
    // This isn't a soundness gate per se, but validates that the hash function
    // distinguishes inputs (not a degenerate constant function).
    #[test]
    fn distinct_inputs_give_distinct_roots() {
        let l = leaf_val();
        let s = sib_val();
        let r0 = merkle_parent(l, s, false); // H_p2(l, s)
        let r1 = merkle_parent(l, s, true);  // H_p2(s, l)
        // Unless H_p2 is symmetric (it's not for arbitrary BabyBear values), these differ.
        // Even if they were equal by coincidence, the circuit would still work correctly —
        // this just documents the expected non-symmetry.
        assert_ne!(
            r0.as_canonical_u32(),
            r1.as_canonical_u32(),
            "H_p2(l,s) != H_p2(s,l) for these values — direction matters"
        );
    }

    // Benchmark (run: cargo test --release bench_merkle -- --nocapture).
    #[test]
    fn bench_prove_verify() {
        let leaf = leaf_val();
        let sib = sib_val();
        let root = merkle_parent(leaf, sib, false);
        let t0 = Instant::now();
        let proof = prove_merkle_path(leaf, sib, false, root);
        let prove_ms = t0.elapsed().as_secs_f64() * 1e3;
        let bytes = proof_to_bytes(&proof);
        let t1 = Instant::now();
        verify_merkle_path(&proof, leaf, sib, false, root).expect("verify");
        let verify_ms = t1.elapsed().as_secs_f64() * 1e3;
        eprintln!(
            "[merkle-path bench] prove={:.1}ms verify={:.1}ms proof_size={} bytes \
             (depth=1, hash=poseidon2-babybear16, width={}, height={})",
            prove_ms, verify_ms, bytes.len(), W, HEIGHT
        );
    }
}
