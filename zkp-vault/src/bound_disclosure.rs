//! Commitment-BOUND selective disclosure (SPRINT_CC_3 P6).
//!
//! The plain `selective_disclosure` proof shows *some* `(earned, perceived)` satisfy
//! the band — it is not tied to the agent's *recorded* values. This module closes
//! that gap with an **in-circuit commitment**: it additionally proves
//! `C == commit(earned, perceived, salt)`,
//! where `C` is a PUBLIC input (the value recorded on-chain / in the DB) and the
//! commitment is computed INSIDE the circuit. So the proof attests that the
//! *committed* `(earned, perceived)` — not arbitrary values — satisfy `earned ≥ x`
//! AND `perceived ≤ earned + band`, still revealing neither.
//!
//! The in-circuit hash here is **MiMC** (`x^7`, the primitive already used by the
//! ownership/aggregate circuits) — `commit = H(H(earned, salt), perceived)`. This is
//! the real binding (no public-input fallback). Swapping MiMC → **Poseidon2** as the
//! commitment hash is the remaining upgrade (a Poseidon2-permutation AIR is a larger,
//! separate build); the binding *property* P6 asks for is delivered here.

use p3_air::{Air, AirBuilderWithPublicValues, BaseAir};
use p3_field::PrimeCharacteristicRing;
use p3_matrix::dense::RowMajorMatrix;
use p3_matrix::Matrix;
use p3_uni_stark::{prove, verify, Proof, VerificationError};

use crate::{make_config, mimc_states, Val, VaultConfig, R, RC};

pub const K: usize = 14;
const HEIGHT: usize = 8;

// Columns (width = 4 + 2K + 2R):
//   [0] earned [1] perceived [2] salt
//   [3 ..= 2+2K]                band bits (2K): K for (earned-x), K for (earned+band-perceived)
//   [3+2K ..= 2+2K+R]          MiMC chain 1 states M1_1..M1_R   (key=salt, input=earned)
//   [3+2K+R]                   h1 = M1_R + earned + salt
//   [4+2K+R ..= 3+2K+2R]       MiMC chain 2 states M2_1..M2_R   (key=perceived, input=h1)
const W: usize = 4 + 2 * K + 2 * R;
const BITS: usize = 3;
const M1: usize = 3 + 2 * K; // M1_1
const H1: usize = 3 + 2 * K + R;
const M2: usize = 4 + 2 * K + R; // M2_1

pub struct BoundBandAir;

impl<F> BaseAir<F> for BoundBandAir {
    fn width(&self) -> usize {
        W
    }
}

impl<AB: AirBuilderWithPublicValues> Air<AB> for BoundBandAir {
    fn eval(&self, builder: &mut AB) {
        let main = builder.main();
        let row = main.row_slice(0).expect("no rows");

        let (x_pv, band_pv, c_pv) = {
            let pis = builder.public_values();
            (pis[0], pis[1], pis[2])
        };
        let x: AB::Expr = x_pv.into();
        let band: AB::Expr = band_pv.into();
        let c_pub: AB::Expr = c_pv.into();

        let earned: AB::Expr = row[0].into();
        let perceived: AB::Expr = row[1].into();
        let salt: AB::Expr = row[2].into();

        let pow7 = |e: AB::Expr| -> AB::Expr {
            let e2 = e.clone() * e.clone();
            let e4 = e2.clone() * e2.clone();
            e4 * e2 * e
        };

        // --- band: earned >= x  AND  perceived <= earned + band ---
        for i in 0..2 * K {
            builder.assert_bool(row[BITS + i]);
        }
        let mut gap_threshold = AB::Expr::ZERO;
        let mut gap_band = AB::Expr::ZERO;
        for i in 0..K {
            let w = AB::Expr::from(AB::F::from_u64(1u64 << i));
            let bt: AB::Expr = row[BITS + i].into();
            let bb: AB::Expr = row[BITS + K + i].into();
            gap_threshold += bt * w.clone();
            gap_band += bb * w;
        }
        builder.assert_eq(gap_threshold, earned.clone() - x);
        builder.assert_eq(gap_band, earned.clone() + band - perceived.clone());

        // --- in-circuit commitment: C == H(H(earned, salt), perceived) ---
        // chain 1: M1_0 = earned, key = salt
        for r in 0..R {
            let prev: AB::Expr = if r == 0 { earned.clone() } else { row[M1 + r - 1].into() };
            let cur: AB::Expr = row[M1 + r].into();
            let rc = AB::Expr::from(AB::F::from_u64(RC[r]));
            builder.assert_eq(cur, pow7(prev + salt.clone() + rc));
        }
        let m1_last: AB::Expr = row[M1 + R - 1].into();
        let h1: AB::Expr = row[H1].into();
        builder.assert_eq(h1.clone(), m1_last + earned + salt);

        // chain 2: M2_0 = h1, key = perceived
        for r in 0..R {
            let prev: AB::Expr = if r == 0 { h1.clone() } else { row[M2 + r - 1].into() };
            let cur: AB::Expr = row[M2 + r].into();
            let rc = AB::Expr::from(AB::F::from_u64(RC[r]));
            builder.assert_eq(cur, pow7(prev + perceived.clone() + rc));
        }
        let m2_last: AB::Expr = row[M2 + R - 1].into();
        builder.assert_eq(c_pub, m2_last + h1 + perceived);
    }
}

/// In-the-clear commitment matching the in-circuit one: H(H(earned, salt), perceived).
pub fn commit(earned: u32, perceived: u32, salt: u64) -> Val {
    let e = Val::from_u64(earned as u64);
    let p = Val::from_u64(perceived as u64);
    let s = Val::from_u64(salt);
    let h1 = mimc_states(e, s)[R - 1] + e + s;
    mimc_states(h1, p)[R - 1] + h1 + p
}

fn generate_trace(earned: u32, perceived: u32, salt: u64, x: u32, band: u32) -> RowMajorMatrix<Val> {
    let e = Val::from_u64(earned as u64);
    let p = Val::from_u64(perceived as u64);
    let s = Val::from_u64(salt);
    let m1 = mimc_states(e, s);
    let h1 = m1[R - 1] + e + s;
    let m2 = mimc_states(h1, p);

    let bits = |v: u32| (0..K).map(move |i| Val::from_u64(((v >> i) & 1) as u64));
    let gap_threshold = earned.wrapping_sub(x);
    let gap_band = earned.wrapping_add(band).wrapping_sub(perceived);

    let mut one = Vec::with_capacity(W);
    one.push(e);
    one.push(p);
    one.push(s);
    one.extend(bits(gap_threshold));
    one.extend(bits(gap_band));
    one.extend_from_slice(&m1);
    one.push(h1);
    one.extend_from_slice(&m2);
    debug_assert_eq!(one.len(), W);

    let mut values = Vec::with_capacity(W * HEIGHT);
    for _ in 0..HEIGHT {
        values.extend_from_slice(&one);
    }
    RowMajorMatrix::new(values, W)
}

fn public_values(x: u32, band: u32, c: Val) -> Vec<Val> {
    vec![Val::from_u64(x as u64), Val::from_u64(band as u64), c]
}

/// Prove the COMMITTED (earned, perceived) satisfy the band, revealing neither.
pub fn prove_bound(earned: u32, perceived: u32, salt: u64, x: u32, band: u32) -> Proof<VaultConfig> {
    let config = make_config();
    let trace = generate_trace(earned, perceived, salt, x, band);
    let c = commit(earned, perceived, salt);
    prove(&config, &BoundBandAir, trace, &public_values(x, band, c))
}

/// Verify against the public commitment `c` and policy `(x, band)`.
pub fn verify_bound(
    proof: &Proof<VaultConfig>,
    x: u32,
    band: u32,
    c: Val,
) -> Result<(), VerificationError<impl core::fmt::Debug>> {
    let config = make_config();
    verify(&config, &BoundBandAir, proof, &public_values(x, band, c))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Accept: the committed values satisfy the band, verified against their commitment.
    #[test]
    fn bound_proof_accepts_for_correct_commitment() {
        let (earned, perceived, salt) = (6000, 5800, 1234567);
        let c = commit(earned, perceived, salt);
        let proof = prove_bound(earned, perceived, salt, 5000, 500);
        verify_bound(&proof, 5000, 500, c).expect("bound proof must verify against its commitment");
    }

    // THE binding: a proof for one (earned,perceived) must NOT verify against a
    // DIFFERENT commitment (i.e. it is tied to the committed values).
    #[test]
    fn rejects_wrong_commitment() {
        let proof = prove_bound(6000, 5800, 1234567, 5000, 500);
        let other_c = commit(9000, 9000, 1234567);
        assert!(verify_bound(&proof, 5000, 500, other_c).is_err(), "must be bound to its commitment");
    }

    // Under-threshold committed values cannot be proven.
    #[test]
    #[should_panic]
    fn rejects_below_threshold() {
        let _ = prove_bound(2000, 1900, 1234567, 5000, 500); // earned 2000 < x 5000
    }
}
