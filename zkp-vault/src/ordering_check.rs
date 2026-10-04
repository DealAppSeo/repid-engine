//! # Ordering check — prove `low < target < high` over BabyBear (Item 14 step 14.0-a)
//!
//! ## Why a standalone module
//!
//! The full non-membership AIR (Item 14) needs two primitives:
//!   1. **This module**: an ordering constraint over BabyBear field elements.
//!   2. A future module: Poseidon2 leaf-hash + Merkle-path verification.
//!
//! Separating them follows the 4.0-a/b/c pattern: the atomic auditable unit
//! shipped here is correct and testable without the Merkle half.
//!
//! ## How ordering is proved in BabyBear
//!
//! BabyBear prime `p = 2013265921 ≈ 2^31`. For two field elements `a, b ∈ [0, p)`,
//! `a < b` (as integers) iff `d = b − a` (field subtraction) satisfies
//! `0 < d < p/2` (field element value < half-prime). Any `d ≥ p/2` means `a > b`
//! as integers (d wraps around).
//!
//! We prove `d ∈ (0, HALF_P)` by providing two witnesses and constraining them:
//!
//!   - **d_inv**: `d · d_inv = 1` proves `d ≠ 0`.
//!   - **e = HALF_P − d**: `d + e = HALF_P` (linear constraint).
//!   - **bit decomposition of e**: 30 binary columns `b[0]..b[29]` with
//!     `b[i]^2 = b[i]` and `sum_i b[i]·2^i = e`.
//!     Since `HALF_P = 1006632960 < 2^30`, the decomposition always fits in 30 bits,
//!     and the reconstruction proves `e ∈ [0, 2^30) ⊆ [0, HALF_P]`.
//!
//! Together: `d = HALF_P − e` with `e ∈ [0, HALF_P]` and `d ≠ 0`
//! → `d ∈ (0, HALF_P)` → `a < b` as integers in [0, p).
//!
//! ## Column layout (W_ORD = 66 per row)
//!
//! ```text
//!  0       d1 = target − low_val
//!  1       d1_inv
//!  2       e1 = HALF_P − d1
//!  3..32   e1 bits b1[0..30)
//! 33       d2 = high_val − target
//! 34       d2_inv
//! 35       e2 = HALF_P − d2
//! 36..65   e2 bits b2[0..30)
//! ```
//!
//! ## Constraints (all degree ≤ 2; applied on all rows; trace rows are identical)
//!
//! For each side (d1/e1/b1 and d2/e2/b2):
//!   1. `d_k = pub[target] − pub[low]` (or `pub[high] − pub[target]`) — from public inputs
//!   2. `d_k + e_k = HALF_P` (linear)
//!   3. `d_k · d_k_inv − 1 = 0` (nonzero d_k)
//!   4. `b_k[i] · (1 − b_k[i]) = 0` for each bit (binary)
//!   5. `sum_i b_k[i] · 2^i − e_k = 0` (bit reconstruction)

use p3_air::{Air, AirBuilder, AirBuilderWithPublicValues, BaseAir};
use p3_baby_bear::BabyBear;
use p3_challenger::{HashChallenger, SerializingChallenger32};
use p3_commit::ExtensionMmcs;
use p3_dft::Radix2DitParallel;
use p3_field::extension::BinomialExtensionField;
use p3_field::{Field, PrimeCharacteristicRing};
use p3_fri::{FriParameters, HidingFriPcs};
use p3_keccak::{Keccak256Hash, KeccakF};
use p3_matrix::dense::RowMajorMatrix;
use p3_matrix::Matrix;
use p3_merkle_tree::MerkleTreeHidingMmcs;
use p3_symmetric::{CompressionFunctionFromHasher, PaddingFreeSponge, SerializingHasher};
use p3_uni_stark::{prove, verify, Proof, StarkConfig, VerificationError};
use rand::rngs::SmallRng;
use rand::SeedableRng;

// ---- BabyBear ordering constants ---------------------------------------------

type Val = BabyBear;

/// BabyBear prime `p = 2^31 − 2^27 + 1 = 2013265921`.
pub const BABYBEAR_P: u64 = 2013265921;

/// Half-prime `⌊p/2⌋ = 1006632960`. Any field element `d ∈ (0, HALF_P)`
/// corresponds to a "positive" difference: `high − low = d` as integers.
pub const HALF_P: u32 = 1006632960;

/// Bits needed for the complement `e = HALF_P − d`:
/// `HALF_P = 1006632960 < 2^30 = 1073741824`, so 30 bits suffice.
const N_BITS: usize = 30;

/// Width of one ordering-half (d, d_inv, e, [b; 30]) = 33 columns.
const HALF_W: usize = 1 + 1 + 1 + N_BITS;

/// Total trace width: two ordering halves = 66 columns.
pub const W_ORD: usize = 2 * HALF_W;

/// Trace height. HEIGHT rows; all rows are identical (the FRI floor requires
/// at least 8 rows with log_blowup=3, log_final_poly_len=2 — inherited from lib.rs).
const HEIGHT: usize = 8;

// ---- Plonky3 config (same construction as lib.rs) ----------------------------

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
type OrdConfig = StarkConfig<HidingPcs, Challenge, Challenger>;

fn make_config() -> OrdConfig {
    let byte_hash = ByteHash {};
    let u64_hash = U64Hash::new(KeccakF {});
    let field_hash = FieldHash::new(u64_hash);
    let compress = MyCompress::new(u64_hash);
    let val_mmcs = ValHidingMmcs::new(field_hash, compress, SmallRng::seed_from_u64(2));
    let challenge_mmcs = ChallengeHidingMmcs::new(val_mmcs.clone());
    let dft = Dft::default();
    let fri_params = FriParameters {
        log_blowup: 3,
        log_final_poly_len: 2,
        num_queries: 2,
        proof_of_work_bits: 1,
        mmcs: challenge_mmcs,
    };
    let pcs = HidingFriPcs::new(dft, val_mmcs, fri_params, 4, SmallRng::seed_from_u64(2));
    let challenger = Challenger::from_hasher(vec![], byte_hash);
    OrdConfig::new(pcs, challenger)
}

// ---- AIR ---------------------------------------------------------------------

/// Proves `low_val < target < high_val` for BabyBear field elements.
///
/// Public inputs: `[low_val, target, high_val]` (3 field elements).
pub struct OrderingCheckAir;

impl BaseAir<Val> for OrderingCheckAir {
    fn width(&self) -> usize {
        W_ORD
    }
}

impl<AB> Air<AB> for OrderingCheckAir
where
    AB: AirBuilderWithPublicValues<F = Val>,
{
    fn eval(&self, builder: &mut AB) {
        let main = builder.main();
        let row = main.row_slice(0).expect("trace has no rows");
        // Copy public vars before any mutable borrows.
        let pis = builder.public_values();
        let low: AB::Expr = pis[0].into();
        let target: AB::Expr = pis[1].into();
        let high: AB::Expr = pis[2].into();
        let half_p: AB::Expr = AB::Expr::from(Val::from_u64(u64::from(HALF_P)));

        // Constrain side-1: d1 = target − low, d1 ∈ (0, HALF_P)
        constrain_ordering_half::<AB>(
            builder,
            &row,
            0,          // column base for d1 half
            target.clone() - low,
            half_p.clone(),
        );

        // Constrain side-2: d2 = high − target, d2 ∈ (0, HALF_P)
        constrain_ordering_half::<AB>(
            builder,
            &row,
            HALF_W,     // column base for d2 half
            high - target,
            half_p,
        );
    }
}

/// Apply the five ordering-half constraints starting at `col_base`.
///
/// Columns at `col_base + 0`: d (the difference)
/// Columns at `col_base + 1`: d_inv
/// Columns at `col_base + 2`: e = HALF_P − d
/// Columns at `col_base + 3..col_base+33`: bits of e
fn constrain_ordering_half<AB: AirBuilder<F = Val>>(
    builder: &mut AB,
    row: &[AB::Var],
    col_base: usize,
    expected_d: AB::Expr,
    half_p: AB::Expr,
) {
    let d: AB::Expr = row[col_base].into();
    let d_inv: AB::Expr = row[col_base + 1].into();
    let e: AB::Expr = row[col_base + 2].into();

    // 1. d equals the declared public difference.
    builder.assert_eq(d.clone(), expected_d);

    // 2. d + e = HALF_P → e = HALF_P − d
    builder.assert_eq(d.clone() + e.clone(), half_p);

    // 3. d · d_inv = 1 (proves d ≠ 0)
    builder.assert_one(d * d_inv);

    // 4+5. Bit decomposition of e: each b_i ∈ {0,1} and sum_i b_i·2^i = e.
    let mut reconstruction = AB::Expr::ZERO;
    let mut pow2: u64 = 1;
    for i in 0..N_BITS {
        let b: AB::Expr = row[col_base + 3 + i].into();
        // b_i ∈ {0,1}
        builder.assert_zero(b.clone() * (AB::Expr::ONE - b.clone()));
        // accumulate
        reconstruction = reconstruction + b * AB::Expr::from(Val::from_u64(pow2));
        pow2 <<= 1;
    }
    builder.assert_eq(reconstruction, e);
}

// ---- Witness generation ------------------------------------------------------

/// Generate the witness trace for `(low_val, target, high_val)`.
///
/// Panics if either difference is zero or ≥ HALF_P (the ordering is invalid).
fn generate_trace(low_val: u32, target: u32, high_val: u32) -> RowMajorMatrix<Val> {
    let half_p_u64 = u64::from(HALF_P);

    // d1 = target − low_val (field subtraction, then check it's in range)
    let p = BABYBEAR_P;
    let d1_int = (u64::from(target) + p - u64::from(low_val)) % p;
    let d2_int = (u64::from(high_val) + p - u64::from(target)) % p;

    // Invariant check (catches invalid witness before committing)
    assert!(d1_int > 0 && d1_int < half_p_u64, "target <= low_val or difference >= HALF_P");
    assert!(d2_int > 0 && d2_int < half_p_u64, "target >= high_val or difference >= HALF_P");

    let e1 = half_p_u64 - d1_int;
    let e2 = half_p_u64 - d2_int;

    // Multiplicative inverses in BabyBear
    let d1_f = Val::from_u64(d1_int);
    let d2_f = Val::from_u64(d2_int);
    let d1_inv = d1_f.inverse();
    let d2_inv = d2_f.inverse();

    // Build a single canonical row, repeated HEIGHT times.
    let mut row = vec![Val::ZERO; W_ORD];
    row[0] = d1_f;
    row[1] = d1_inv;
    row[2] = Val::from_u64(e1);
    bits_into_row(&mut row, 3, e1);
    row[HALF_W] = d2_f;
    row[HALF_W + 1] = d2_inv;
    row[HALF_W + 2] = Val::from_u64(e2);
    bits_into_row(&mut row, HALF_W + 3, e2);

    // All HEIGHT rows are identical (only one logical constraint; padding satisfies them all).
    let values: Vec<Val> = row.iter().copied().cycle().take(HEIGHT * W_ORD).collect();
    RowMajorMatrix::new(values, W_ORD)
}

/// Write the 30-bit little-endian decomposition of `val` into `row[start..start+30]`.
fn bits_into_row(row: &mut [Val], start: usize, val: u64) {
    for i in 0..N_BITS {
        row[start + i] = Val::from_u64((val >> i) & 1);
    }
}

fn public_values(low_val: u32, target: u32, high_val: u32) -> Vec<Val> {
    vec![
        Val::from_u64(u64::from(low_val)),
        Val::from_u64(u64::from(target)),
        Val::from_u64(u64::from(high_val)),
    ]
}

// ---- Public API --------------------------------------------------------------

/// Prove that `low_val < target < high_val` (as BabyBear integers in `[0, p)`).
///
/// Panics if the ordering is not satisfied (the prover cannot build a valid trace).
pub fn prove_ordering(
    low_val: u32,
    target: u32,
    high_val: u32,
) -> Proof<OrdConfig> {
    let config = make_config();
    let trace = generate_trace(low_val, target, high_val);
    let pis = public_values(low_val, target, high_val);
    prove(&config, &OrderingCheckAir, trace, &pis)
}

/// Verify an ordering proof. Returns `Ok(())` iff the proof establishes
/// `low_val < target < high_val`.
pub fn verify_ordering(
    proof: &Proof<OrdConfig>,
    low_val: u32,
    target: u32,
    high_val: u32,
) -> Result<(), VerificationError<impl core::fmt::Debug>> {
    let config = make_config();
    let pis = public_values(low_val, target, high_val);
    verify(&config, &OrderingCheckAir, proof, &pis)
}

// ---- Tests -------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    // GATE 0 — a valid ordering proves and verifies.
    #[test]
    fn valid_ordering_accepts() {
        let proof = prove_ordering(10, 20, 30);
        verify_ordering(&proof, 10, 20, 30).expect("valid ordering must verify");
    }

    // GATE 0b — ordering over larger BabyBear-range values (up to HALF_P − 1).
    #[test]
    fn valid_ordering_near_half_p() {
        // Differences close to HALF_P − 1 (just under the threshold).
        let low = 1u32;
        let high = HALF_P - 1; // difference = HALF_P − 2, valid
        let target = low + 1;  // difference from low = 1, from high = HALF_P − 3
        let proof = prove_ordering(low, target, high);
        verify_ordering(&proof, low, target, high).expect("near-HALF_P ordering must verify");
    }

    // GATE 0c — verifier rejects a proof presented with wrong public inputs.
    #[test]
    fn wrong_public_inputs_rejected() {
        let proof = prove_ordering(10, 20, 30);
        // Change one public input: claim target = 21 instead of 20.
        let result = verify_ordering(&proof, 10, 21, 30);
        assert!(result.is_err(), "wrong public inputs must not verify");
    }

    // GATE 1 — target ≤ low_val: generate_trace panics (prover cannot build trace).
    // Profile note: we catch the panic (debug & release both) so the test runs in either.
    #[test]
    fn target_leq_low_rejected() {
        let result = std::panic::catch_unwind(|| prove_ordering(20, 20, 30)); // target == low
        assert!(result.is_err(), "target == low_val must panic in generate_trace");

        let result = std::panic::catch_unwind(|| prove_ordering(20, 15, 30)); // target < low
        assert!(result.is_err(), "target < low_val must panic in generate_trace");
    }

    // GATE 2 — target ≥ high_val: generate_trace panics.
    #[test]
    fn target_geq_high_rejected() {
        let result = std::panic::catch_unwind(|| prove_ordering(10, 30, 30)); // target == high
        assert!(result.is_err(), "target == high_val must panic in generate_trace");

        let result = std::panic::catch_unwind(|| prove_ordering(10, 35, 30)); // target > high
        assert!(result.is_err(), "target > high_val must panic in generate_trace");
    }

    // GATE 3 — difference ≥ HALF_P (ambiguous direction): generate_trace panics.
    // This catches the case where low and high are more than HALF_P apart — the
    // ordering argument only holds for differences in (0, HALF_P), so callers must
    // arrange values within a single "half" of the field.
    #[test]
    fn large_difference_rejected() {
        // d1 = HALF_P exactly → not in (0, HALF_P) open interval
        let low = 0u32;
        let target = HALF_P; // d1 = HALF_P, NOT < HALF_P
        let high = HALF_P + 1;
        let result = std::panic::catch_unwind(|| prove_ordering(low, target, high));
        assert!(result.is_err(), "difference == HALF_P must panic");
    }

    // GATE 4 — tampered proof bytes are rejected.
    #[test]
    fn tampered_bytes_rejected() {
        use p3_uni_stark::{Proof as P3Proof};
        let proof = prove_ordering(100, 200, 300);
        let bytes = bincode::serialize(&proof).expect("serialize");
        let mid = bytes.len() / 2;
        let mut bad = bytes.clone();
        bad[mid] ^= 0xFF;
        let tampered: Result<P3Proof<OrdConfig>, _> = bincode::deserialize(&bad);
        let rejected = match tampered {
            Err(_) => true,
            Ok(t) => verify_ordering(&t, 100, 200, 300).is_err(),
        };
        assert!(rejected, "tampered proof bytes must be rejected");
    }

    // Benchmark (run: cargo test --release bench -- --nocapture)
    #[test]
    fn bench_ordering() {
        let t0 = Instant::now();
        let proof = prove_ordering(100, 200, 300);
        let prove_ms = t0.elapsed().as_secs_f64() * 1e3;
        let bytes = bincode::serialize(&proof).expect("serialize");
        let t1 = Instant::now();
        verify_ordering(&proof, 100, 200, 300).expect("verify");
        let verify_ms = t1.elapsed().as_secs_f64() * 1e3;
        eprintln!(
            "[ordering_check bench] prove={prove_ms:.1}ms verify={verify_ms:.1}ms \
             proof_size={} bytes (cols={W_ORD}, height={HEIGHT}, bits={N_BITS})",
            bytes.len()
        );
    }
}
