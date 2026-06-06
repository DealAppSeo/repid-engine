//! Selective-disclosure proof for multi-dimensional RepID (D-030).
//!
//! Generalizes the PARKED tier-range proof (PR #95, retained per D-019a) into the
//! live D-030 use-case: **gate on `earned` without revealing the number**, and
//! enforce a **healthy earned/perceived gap** (anti-inflation) — all in zero
//! knowledge.
//!
//! ## Statement
//! - **Public inputs:** `x` (the earned threshold) and `band` (max amount perceived
//!   may exceed earned by — the anti-inflation band).
//! - **Private witness:** `earned`, `perceived` — NEVER revealed (not in public inputs).
//! - **Proves, in ZK:**
//!   1. `earned >= x`                          (threshold gate — D-030 "gate on EARNED")
//!   2. `perceived <= earned + band`           (HEALTHY gap — rejects OVER-PERCEIVED,
//!                                              the red-flag state; UNDER-RECOGNIZED is fine)
//!
//! Both are range facts: `earned - x` and `(earned + band) - perceived` are each
//! proven to be a sum of `K` boolean bits, hence in `[0, 2^K)`. With RepID in
//! `[0, 10000] < 2^14` and small public `x, band`, `K = 14` covers it and there is
//! no BabyBear wraparound. Constraint degree is 2 (booleanity), so the shared
//! production hiding-FRI config applies directly.
//!
//! Per D-030, this gates on EARNED with a healthy gap and NEVER reveals the values —
//! exactly question 4 of the RepID RFC ("earned >= X AND a healthy gap").
//!
//! Scope (same as the sibling proofs): binding the witness to the agent's *recorded*
//! earned/perceived (a Poseidon2 commitment as a public input) is the documented
//! next step; this proves the band statement over a private witness.

use p3_air::{Air, AirBuilderWithPublicValues, BaseAir};
use p3_field::PrimeCharacteristicRing;
use p3_matrix::dense::RowMajorMatrix;
use p3_matrix::Matrix;
use p3_uni_stark::{prove, verify, Proof, VerificationError};

use crate::{make_config, Val, VaultConfig};

/// Range bits (RepID in [0, 10000] < 2^14).
pub const K: usize = 14;
const HEIGHT: usize = 8;
// Columns: [earned, perceived, bits(earned-x) x K, bits((earned+band)-perceived) x K]
const W: usize = 2 + 2 * K;

pub struct BandAir;

impl<F> BaseAir<F> for BandAir {
    fn width(&self) -> usize {
        W
    }
}

impl<AB: AirBuilderWithPublicValues> Air<AB> for BandAir {
    fn eval(&self, builder: &mut AB) {
        let main = builder.main();
        let row = main.row_slice(0).expect("trace has no rows");

        let (x_pv, band_pv) = {
            let pis = builder.public_values();
            (pis[0], pis[1])
        };
        let x: AB::Expr = x_pv.into();
        let band: AB::Expr = band_pv.into();

        let earned: AB::Expr = row[0].into();
        let perceived: AB::Expr = row[1].into();

        // All bit columns must be boolean.
        for i in 0..2 * K {
            builder.assert_bool(row[2 + i]);
        }

        // Recompose the two gaps and bind them to the public threshold/band.
        let mut gap_threshold = AB::Expr::ZERO; // == earned - x        (earned >= x)
        let mut gap_band = AB::Expr::ZERO; // == (earned + band) - perceived (perceived <= earned + band)
        for i in 0..K {
            let weight = AB::Expr::from(AB::F::from_u64(1u64 << i));
            let b_t: AB::Expr = row[2 + i].into();
            let b_b: AB::Expr = row[2 + K + i].into();
            gap_threshold += b_t * weight.clone();
            gap_band += b_b * weight;
        }
        // earned - x == gap_threshold   (>= 0 and < 2^K  ⇒  earned >= x)
        builder.assert_eq(gap_threshold, earned.clone() - x);
        // (earned + band) - perceived == gap_band  (>= 0 and < 2^K ⇒ perceived <= earned + band)
        builder.assert_eq(gap_band, earned + band - perceived);
    }
}

fn le_bits(v: u32) -> impl Iterator<Item = Val> {
    (0..K).map(move |i| Val::from_u64(((v >> i) & 1) as u64))
}

/// Build the (replicated) trace. Caller guarantees `earned >= x` and
/// `perceived <= earned + band`; otherwise the gaps don't fit in K bits and
/// proving fails (the soundness we want — see the rejection tests).
pub fn generate_trace(earned: u32, perceived: u32, x: u32, band: u32) -> RowMajorMatrix<Val> {
    let gap_threshold = earned.wrapping_sub(x);
    let gap_band = (earned.wrapping_add(band)).wrapping_sub(perceived);
    let mut one = Vec::with_capacity(W);
    one.push(Val::from_u64(earned as u64));
    one.push(Val::from_u64(perceived as u64));
    one.extend(le_bits(gap_threshold));
    one.extend(le_bits(gap_band));
    debug_assert_eq!(one.len(), W);

    let mut values = Vec::with_capacity(W * HEIGHT);
    for _ in 0..HEIGHT {
        values.extend_from_slice(&one);
    }
    RowMajorMatrix::new(values, W)
}

fn public_values(x: u32, band: u32) -> Vec<Val> {
    vec![Val::from_u64(x as u64), Val::from_u64(band as u64)]
}

/// Prove `earned >= x` AND `perceived <= earned + band`, revealing neither value.
pub fn prove_band(earned: u32, perceived: u32, x: u32, band: u32) -> Proof<VaultConfig> {
    let config = make_config();
    let trace = generate_trace(earned, perceived, x, band);
    prove(&config, &BandAir, trace, &public_values(x, band))
}

/// Verify the band statement. The verifier learns only `(x, band)`.
pub fn verify_band(
    proof: &Proof<VaultConfig>,
    x: u32,
    band: u32,
) -> Result<(), VerificationError<impl core::fmt::Debug>> {
    let config = make_config();
    verify(&config, &BandAir, proof, &public_values(x, band))
}

/// Gated-access demo: grant access iff the proof verifies for the policy `(x, band)`.
/// Takes ONLY the proof and the public policy — never the earned/perceived values.
pub fn gated_access(proof: &Proof<VaultConfig>, x: u32, band: u32) -> bool {
    verify_band(proof, x, band).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{proof_from_bytes, proof_to_bytes};

    // GATE — accept: above threshold AND healthy gap (under-recognized direction).
    #[test]
    fn accept_above_threshold_healthy_under_recognized() {
        // earned 2000 >= x 1000; perceived 1900 <= 2000+500 (gap fine).
        let proof = prove_band(2000, 1900, 1000, 500);
        assert!(gated_access(&proof, 1000, 500), "healthy + above threshold must pass");
    }

    // GATE — accept: perceived slightly above earned but WITHIN the band.
    #[test]
    fn accept_perceived_within_band() {
        // perceived 2300, earned 2000, band 500 → 2300 <= 2500 ok; earned >= 1000.
        let proof = prove_band(2000, 2300, 1000, 500);
        assert!(gated_access(&proof, 1000, 500));
    }

    // GATE — reject BELOW threshold: earned < x cannot be proven.
    #[test]
    #[should_panic]
    fn reject_below_threshold() {
        let _ = prove_band(500, 500, 1000, 500); // earned 500 < x 1000
    }

    // GATE — reject UNHEALTHY gap: over-perceived beyond band cannot be proven.
    #[test]
    #[should_panic]
    fn reject_over_perceived_gap() {
        // perceived 2000, earned 1000, band 500 → perceived - earned = 1000 > 500.
        let _ = prove_band(1000, 2000, 1000, 500);
    }

    // Binding to the public policy: a proof for (x=1000) must not verify at (x=3000).
    #[test]
    fn reject_wrong_policy() {
        let proof = prove_band(2000, 1900, 1000, 500);
        assert!(!gated_access(&proof, 3000, 500), "must not satisfy a stricter threshold");
    }

    // Tampered proof is rejected.
    #[test]
    fn reject_tampered() {
        let proof = prove_band(2000, 1900, 1000, 500);
        let mut bytes = proof_to_bytes(&proof);
        assert!(gated_access(&proof_from_bytes(&bytes).unwrap(), 1000, 500));
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xFF;
        let rejected = match proof_from_bytes(&bytes) {
            Err(_) => true,
            Ok(t) => !gated_access(&t, 1000, 500),
        };
        assert!(rejected, "tampered proof must be rejected");
    }
}
