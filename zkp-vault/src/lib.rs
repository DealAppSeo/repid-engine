//! # zkp-vault — real Plonky3 zero-knowledge vault for RepID
//!
//! Replaces the TypeScript Plonky3 stub (`src/zkp/plonky3-stub.ts`,
//! `src/zkp/plonky3-real.ts`) with a genuine STARK. The TS bridge stays as the
//! interface/contract (it POSTs to a prover and reads `proof_bytes`); this crate
//! is the real cryptography behind it.
//!
//! ## The statement (the ONE concrete RepID-tier case)
//!
//! Public inputs: a tier's RepID bounds `(tier_lo, tier_hi)`.
//! Private witness: the agent's exact `score` (NEVER revealed).
//!
//! The proof convinces a verifier that the prover knows a `score` with
//! `tier_lo <= score <= tier_hi` — i.e. the agent legitimately sits in the
//! claimed tier — WITHOUT disclosing the score. Range is enforced by proving
//! `score - tier_lo` and `tier_hi - score` are each a sum of `K` boolean bits
//! (so each lies in `[0, 2^K)`); with RepID in `[0, 10000]`, `K = 14` covers it
//! and there is no field wraparound in BabyBear (`p ~ 2^31`).
//!
//! Zero-knowledge comes from the **hiding** FRI PCS (`HidingFriPcs` +
//! `MerkleTreeHidingMmcs`) — the same construction Plonky3 ships in its own
//! `test_zk`. The score sits only in the private trace, never in `public_values`.
//!
//! ## Honesty / scope
//! - FRI parameters here use `create_test_fri_params` (low blowup) — correct for
//!   the correctness gate + benchmarking, NOT production soundness. Production
//!   hardening (real FRI params, a Poseidon2 commitment binding the score to an
//!   external value, and recursive aggregation) is the documented next step.
//! - The correctness gate (accept valid / reject false claim / reject tampered)
//!   is proven in the tests below before anything depends on this.

use p3_air::{Air, AirBuilderWithPublicValues, BaseAir};
use p3_baby_bear::BabyBear;
use p3_challenger::{HashChallenger, SerializingChallenger32};
use p3_commit::ExtensionMmcs;
use p3_dft::Radix2DitParallel;
use p3_field::extension::BinomialExtensionField;
use p3_field::PrimeCharacteristicRing;
use p3_fri::{create_test_fri_params, HidingFriPcs};
use p3_keccak::{Keccak256Hash, KeccakF};
use p3_matrix::dense::RowMajorMatrix;
use p3_matrix::Matrix;
use p3_merkle_tree::MerkleTreeHidingMmcs;
use p3_symmetric::{CompressionFunctionFromHasher, PaddingFreeSponge, SerializingHasher};
use p3_uni_stark::{prove, verify, Proof, StarkConfig, VerificationError};
use rand::rngs::SmallRng;
use rand::SeedableRng;

/// Number of range bits. RepID in [0, 10000] < 2^14, so K = 14 is sufficient and
/// `2^14` never overflows BabyBear.
pub const K: usize = 14;

/// Trace height (power of two). The statement is single-row; we replicate the
/// same valid row so every (unconditional) constraint holds on every row.
const HEIGHT: usize = 8;

/// Column layout: [ score | bits_of(score - lo) x K | bits_of(hi - score) x K ].
const WIDTH: usize = 1 + 2 * K;

// ---- Plonky3 config (BabyBear + Keccak hiding MMCS + hiding FRI PCS) ----------
type Val = BabyBear;
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
type VaultConfig = StarkConfig<HidingPcs, Challenge, Challenger>;

/// Canonical RepID tier → (lo, hi) bounds (CLAUDE.md, 5-tier scheme 2026-05-08).
pub fn tier_bounds(tier: &str) -> Option<(u32, u32)> {
    match tier {
        "PROBATIONARY" => Some((0, 499)),
        "EARNING" => Some((500, 999)),
        "ESTABLISHED" => Some((1000, 4999)),
        "AUTONOMOUS" => Some((5000, 7999)),
        "VETERAN" => Some((8000, 10000)),
        _ => None,
    }
}

/// The AIR: enforce booleanity + recomposition of the two range gaps.
pub struct RepIdTierAir;

impl<F> BaseAir<F> for RepIdTierAir {
    fn width(&self) -> usize {
        WIDTH
    }
}

impl<AB: AirBuilderWithPublicValues> Air<AB> for RepIdTierAir {
    fn eval(&self, builder: &mut AB) {
        let main = builder.main();
        let row = main.row_slice(0).expect("trace has no rows");

        let pis = builder.public_values();
        let lo: AB::Expr = pis[0].into();
        let hi: AB::Expr = pis[1].into();
        let score: AB::Expr = row[0].into();

        // Every bit column must be boolean.
        for i in 0..2 * K {
            builder.assert_bool(row[1 + i]);
        }

        // Recompose the two gaps from their bits and bind them to the bounds.
        let mut gap_lo = AB::Expr::ZERO; // == score - lo
        let mut gap_hi = AB::Expr::ZERO; // == hi - score
        for i in 0..K {
            let weight = AB::Expr::from(AB::F::from_u64(1u64 << i));
            let b_lo: AB::Expr = row[1 + i].into();
            let b_hi: AB::Expr = row[1 + K + i].into();
            gap_lo += b_lo * weight.clone();
            gap_hi += b_hi * weight;
        }
        // score - lo == gap_lo  (so lo <= score, and score - lo < 2^K)
        builder.assert_eq(gap_lo, score.clone() - lo);
        // hi - score == gap_hi  (so score <= hi, and hi - score < 2^K)
        builder.assert_eq(gap_hi, hi - score);
    }
}

fn le_bits(v: u32) -> impl Iterator<Item = Val> {
    (0..K).map(move |i| Val::from_u64(((v >> i) & 1) as u64))
}

/// Build the (replicated) trace for a concrete (score, lo, hi). Caller guarantees
/// lo <= score <= hi; otherwise the gaps don't fit in K bits and proving fails
/// (which is exactly the soundness we want — see `false_witness_is_unprovable`).
pub fn generate_trace(score: u32, lo: u32, hi: u32) -> RowMajorMatrix<Val> {
    let gap_lo = score.wrapping_sub(lo);
    let gap_hi = hi.wrapping_sub(score);
    let mut one_row: Vec<Val> = Vec::with_capacity(WIDTH);
    one_row.push(Val::from_u64(score as u64));
    one_row.extend(le_bits(gap_lo));
    one_row.extend(le_bits(gap_hi));
    debug_assert_eq!(one_row.len(), WIDTH);

    let mut values = Vec::with_capacity(WIDTH * HEIGHT);
    for _ in 0..HEIGHT {
        values.extend_from_slice(&one_row);
    }
    RowMajorMatrix::new(values, WIDTH)
}

fn make_config() -> VaultConfig {
    let byte_hash = ByteHash {};
    let u64_hash = U64Hash::new(KeccakF {});
    let field_hash = FieldHash::new(u64_hash);
    let compress = MyCompress::new(u64_hash);
    let val_mmcs = ValHidingMmcs::new(field_hash, compress, SmallRng::seed_from_u64(1));
    let challenge_mmcs = ChallengeHidingMmcs::new(val_mmcs.clone());
    let dft = Dft::default();
    let fri_params = create_test_fri_params(challenge_mmcs, 2);
    let pcs = HidingPcs::new(dft, val_mmcs, fri_params, 4, SmallRng::seed_from_u64(1));
    let challenger = Challenger::from_hasher(vec![], byte_hash);
    VaultConfig::new(pcs, challenger)
}

/// Public inputs for the statement: the claimed tier's bounds.
fn public_values(lo: u32, hi: u32) -> Vec<Val> {
    vec![Val::from_u64(lo as u64), Val::from_u64(hi as u64)]
}

/// Prove that a (private) `score` lies within `[lo, hi]`. Returns the STARK proof.
pub fn prove_tier(score: u32, lo: u32, hi: u32) -> Proof<VaultConfig> {
    let config = make_config();
    let trace = generate_trace(score, lo, hi);
    prove(&config, &RepIdTierAir, trace, &public_values(lo, hi))
}

/// Verify a proof against the claimed bounds. Reveals nothing about the score.
pub fn verify_tier(
    proof: &Proof<VaultConfig>,
    lo: u32,
    hi: u32,
) -> Result<(), VerificationError<impl core::fmt::Debug>> {
    let config = make_config();
    verify(&config, &RepIdTierAir, proof, &public_values(lo, hi))
}

/// Serialize a proof to bytes (the `proof_bytes` the TS bridge expects).
pub fn proof_to_bytes(proof: &Proof<VaultConfig>) -> Vec<u8> {
    bincode::serialize(proof).expect("proof serialization")
}

/// Deserialize proof bytes (may fail on tampering → treat as rejection).
pub fn proof_from_bytes(bytes: &[u8]) -> Result<Proof<VaultConfig>, bincode::Error> {
    bincode::deserialize(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    // GATE 1 — accept a valid proof.
    #[test]
    fn valid_proof_accepts() {
        let (lo, hi) = tier_bounds("ESTABLISHED").unwrap(); // 1000..=4999
        let proof = prove_tier(1500, lo, hi);
        verify_tier(&proof, lo, hi).expect("valid proof must verify");
    }

    // Edge values of the tier band must still verify.
    #[test]
    fn boundary_scores_accept() {
        let (lo, hi) = tier_bounds("VETERAN").unwrap(); // 8000..=10000
        verify_tier(&prove_tier(lo, lo, hi), lo, hi).expect("low edge");
        verify_tier(&prove_tier(hi, lo, hi), lo, hi).expect("high edge");
    }

    // GATE 2 — reject a FALSE CLAIM: a proof honestly built for ESTABLISHED must
    // NOT verify when presented against VETERAN's public bounds.
    #[test]
    fn false_claim_rejected() {
        let (elo, ehi) = tier_bounds("ESTABLISHED").unwrap();
        let proof = prove_tier(1500, elo, ehi); // truthfully in ESTABLISHED
        let (vlo, vhi) = tier_bounds("VETERAN").unwrap();
        assert!(
            verify_tier(&proof, vlo, vhi).is_err(),
            "a proof for ESTABLISHED must not verify as VETERAN"
        );
    }

    // GATE 3 — reject a TAMPERED proof: flip a byte, verification must fail
    // (or deserialization must fail — either way the tamper is rejected).
    #[test]
    fn tampered_proof_rejected() {
        let (lo, hi) = tier_bounds("ESTABLISHED").unwrap();
        let proof = prove_tier(1500, lo, hi);
        let mut bytes = proof_to_bytes(&proof);
        // verify the clean round-trip first
        verify_tier(&proof_from_bytes(&bytes).unwrap(), lo, hi).expect("clean round-trip verifies");
        // tamper a byte in the middle of the proof body
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xFF;
        let rejected = match proof_from_bytes(&bytes) {
            Err(_) => true,                                  // structurally broken
            Ok(tampered) => verify_tier(&tampered, lo, hi).is_err(), // or cryptographically invalid
        };
        assert!(rejected, "a tampered proof must be rejected");
    }

    // Soundness of the prover itself: an out-of-range (false) witness cannot be
    // proven — debug builds catch it in check_constraints (mirrors Plonky3's own
    // test_incorrect_public_value pattern).
    #[test]
    #[should_panic]
    fn false_witness_is_unprovable() {
        let (lo, hi) = tier_bounds("ESTABLISHED").unwrap(); // 1000..=4999
        let _ = prove_tier(500, lo, hi); // 500 is NOT in ESTABLISHED
    }

    // Benchmark prove + verify cost/latency (run: cargo test --release -- --nocapture bench).
    #[test]
    fn bench_prove_verify() {
        let (lo, hi) = tier_bounds("ESTABLISHED").unwrap();
        let t0 = Instant::now();
        let proof = prove_tier(2500, lo, hi);
        let prove_ms = t0.elapsed().as_secs_f64() * 1e3;
        let bytes = proof_to_bytes(&proof);
        let t1 = Instant::now();
        verify_tier(&proof, lo, hi).expect("verify");
        let verify_ms = t1.elapsed().as_secs_f64() * 1e3;
        eprintln!(
            "[zkp-vault bench] prove={:.1}ms verify={:.1}ms proof_size={} bytes (K={}, height={})",
            prove_ms,
            verify_ms,
            bytes.len(),
            K,
            HEIGHT
        );
    }
}
