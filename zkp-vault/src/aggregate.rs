//! Batch aggregation of anonymous-ownership statements (SPRINT_CC_3 P1).
//!
//! Proves **N ownership statements in ONE STARK** — the headline "aggregate N into
//! one proof" capability. Each trace row carries one owner's full witness
//! (secret, agent_id, context), proves the same per-row facts as the single
//! `ownership` circuit (MiMC leaf ∈ group, correct per-context nullifier), and a
//! transition-accumulated fingerprint binds the whole nullifier SET into ONE public
//! `batch_digest`. One forged row (a non-member) makes its membership constraint
//! non-zero → the whole proof fails.
//!
//! ## Honesty: aggregation, not (yet) recursive proof-composition
//! This is **batch aggregation** — one proof attesting to N statements — NOT
//! recursive verification (a STARK whose AIR *verifies* N inner STARK proofs via an
//! in-circuit FRI verifier). True recursion needs a FRI-verifier AIR, which Plonky3
//! 0.3 does not ship and is a multi-week build; it is the documented next step. The
//! DONE-CHECK ("aggregate of valid verifies; aggregate with one forged fails") is met
//! at the statement level by this construction, and the single `batch_digest` is what
//! gets anchored on-chain (P5).
//!
//! Public inputs: `[C_0..C_{M-1}, batch_digest]`. Private witness: every owner's
//! `(secret, agent_id, context)` — none revealed.

use p3_air::{Air, AirBuilder, AirBuilderWithPublicValues, BaseAir};
use p3_field::PrimeCharacteristicRing;
use p3_matrix::dense::RowMajorMatrix;
use p3_matrix::Matrix;
use p3_uni_stark::{prove, verify, Proof, VerificationError};

use crate::{commitment, make_config, mimc_states, nullifier, Val, VaultConfig, GROUP_SIZE, R, RC};

/// Number of owners aggregated per proof (trace height; power of two).
pub const N_OWNERS: usize = 8;
/// Fingerprint multiplier for the nullifier-set accumulator.
const GAMMA: u64 = 3;

// Column layout (width = 2R + 6):
//   [0] secret [1] agent_id [2] context [3] nullifier
//   [4 ..= R+3]      leaf MiMC states L_1..L_R      (L_0 = secret)
//   [R+4 ..= 2R+3]   nullifier MiMC states N_1..N_R (N_0 = secret)
//   [2R+4] leaf   [2R+5] acc
const W: usize = 2 * R + 6;
const LEAF: usize = 2 * R + 4;
const ACC: usize = 2 * R + 5;

pub struct AggregateAir;

impl<F> BaseAir<F> for AggregateAir {
    fn width(&self) -> usize {
        W
    }
}

impl<AB: AirBuilderWithPublicValues> Air<AB> for AggregateAir {
    fn eval(&self, builder: &mut AB) {
        let main = builder.main();
        let local = main.row_slice(0).expect("no rows");
        let next = main.row_slice(1).expect("need >= 2 rows");

        // Copy public vars out before the mutable assert_* calls.
        let (group_pv, digest_pv) = {
            let pis = builder.public_values();
            (
                (0..GROUP_SIZE).map(|j| pis[j]).collect::<Vec<_>>(),
                pis[GROUP_SIZE],
            )
        };

        let pow7 = |e: AB::Expr| -> AB::Expr {
            let e2 = e.clone() * e.clone();
            let e4 = e2.clone() * e2.clone();
            e4 * e2 * e
        };

        let secret: AB::Expr = local[0].into();
        let agent_id: AB::Expr = local[1].into();
        let context: AB::Expr = local[2].into();
        let null_col: AB::Expr = local[3].into();

        // Leaf MiMC: L_0 = secret, L_{r+1} = (L_r + agent_id + RC[r])^7.
        for r in 0..R {
            let prev: AB::Expr = if r == 0 { secret.clone() } else { local[3 + r].into() };
            let cur: AB::Expr = local[4 + r].into();
            let rc = AB::Expr::from(AB::F::from_u64(RC[r]));
            builder.assert_eq(cur, pow7(prev + agent_id.clone() + rc));
        }
        let l_last: AB::Expr = local[3 + R].into();
        let leaf: AB::Expr = local[LEAF].into();
        builder.assert_eq(leaf.clone(), l_last + secret.clone() + agent_id);

        // Nullifier MiMC: N_0 = secret, N_{r+1} = (N_r + context + RC[r])^7.
        for r in 0..R {
            let prev: AB::Expr = if r == 0 { secret.clone() } else { local[3 + R + r].into() };
            let cur: AB::Expr = local[4 + R + r].into();
            let rc = AB::Expr::from(AB::F::from_u64(RC[r]));
            builder.assert_eq(cur, pow7(prev + context.clone() + rc));
        }
        let n_last: AB::Expr = local[3 + 2 * R].into();
        builder.assert_eq(null_col.clone(), n_last + secret + context);

        // Membership: leaf is one of the public group commitments.
        let mut prod: AB::Expr = leaf.clone() - group_pv[0].into();
        for j in 1..GROUP_SIZE {
            prod = prod * (leaf.clone() - group_pv[j].into());
        }
        builder.assert_zero(prod);

        // Nullifier-set accumulator: acc_0 = null_0; acc_{i+1} = acc_i*GAMMA + null_{i+1};
        // acc_{last} == batch_digest (public).
        let gamma = AB::Expr::from(AB::F::from_u64(GAMMA));
        let acc_local: AB::Expr = local[ACC].into();
        let acc_next: AB::Expr = next[ACC].into();
        let null_next: AB::Expr = next[3].into();
        builder.when_first_row().assert_eq(acc_local.clone(), null_col);
        builder
            .when_transition()
            .assert_eq(acc_next, acc_local.clone() * gamma + null_next);
        builder.when_last_row().assert_eq(acc_local, digest_pv.into());
    }
}

/// Compute the public batch digest (nullifier-set fingerprint) for a set of owners.
pub fn batch_digest(owners: &[(u64, u64, u64); N_OWNERS]) -> Val {
    let gamma = Val::from_u64(GAMMA);
    let mut acc = Val::ZERO;
    for (i, (secret, _aid, context)) in owners.iter().enumerate() {
        let n = nullifier(*secret, *context);
        acc = if i == 0 { n } else { acc * gamma + n };
    }
    acc
}

fn generate_trace(owners: &[(u64, u64, u64); N_OWNERS]) -> RowMajorMatrix<Val> {
    let gamma = Val::from_u64(GAMMA);
    let mut values = Vec::with_capacity(W * N_OWNERS);
    let mut acc = Val::ZERO;
    for (i, &(secret, agent_id, context)) in owners.iter().enumerate() {
        let s = Val::from_u64(secret);
        let aid = Val::from_u64(agent_id);
        let ctx = Val::from_u64(context);
        let l = mimc_states(s, aid);
        let n = mimc_states(s, ctx);
        let leaf = l[R - 1] + s + aid;
        let null = n[R - 1] + s + ctx;
        acc = if i == 0 { null } else { acc * gamma + null };

        let mut row = Vec::with_capacity(W);
        row.push(s);
        row.push(aid);
        row.push(ctx);
        row.push(null);
        row.extend_from_slice(&l);
        row.extend_from_slice(&n);
        row.push(leaf);
        row.push(acc);
        debug_assert_eq!(row.len(), W);
        values.extend_from_slice(&row);
    }
    RowMajorMatrix::new(values, W)
}

fn public_values(group: &[Val; GROUP_SIZE], digest: Val) -> Vec<Val> {
    let mut pis = group.to_vec();
    pis.push(digest);
    pis
}

/// Prove that all `N_OWNERS` owners control a registered identity in `group`.
pub fn prove_aggregate(
    owners: &[(u64, u64, u64); N_OWNERS],
    group: &[Val; GROUP_SIZE],
) -> Proof<VaultConfig> {
    let config = make_config();
    let trace = generate_trace(owners);
    let digest = batch_digest(owners);
    prove(&config, &AggregateAir, trace, &public_values(group, digest))
}

/// Verify an aggregate proof against the group and the expected batch digest.
pub fn verify_aggregate(
    proof: &Proof<VaultConfig>,
    group: &[Val; GROUP_SIZE],
    digest: Val,
) -> Result<(), VerificationError<impl core::fmt::Debug>> {
    let config = make_config();
    verify(&config, &AggregateAir, proof, &public_values(group, digest))
}

/// Convenience: a 4-member group containing all `members` (helper for callers/tests).
pub fn group_of(members: &[(u64, u64)]) -> [Val; GROUP_SIZE] {
    let mut g = [
        commitment(1, 1),
        commitment(2, 2),
        commitment(3, 3),
        commitment(4, 4),
    ];
    for (i, &(s, a)) in members.iter().take(GROUP_SIZE).enumerate() {
        g[i] = commitment(s, a);
    }
    g
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_owners() -> [(u64, u64, u64); N_OWNERS] {
        // 8 owners drawn from a 4-member group (members reused across contexts).
        [
            (10, 100, 901),
            (20, 200, 902),
            (30, 300, 903),
            (40, 400, 904),
            (10, 100, 905),
            (20, 200, 906),
            (30, 300, 907),
            (40, 400, 908),
        ]
    }
    fn group() -> [Val; GROUP_SIZE] {
        group_of(&[(10, 100), (20, 200), (30, 300), (40, 400)])
    }

    // GATE — aggregate of valid statements verifies.
    #[test]
    fn aggregate_of_valid_verifies() {
        let owners = valid_owners();
        let g = group();
        let proof = prove_aggregate(&owners, &g);
        verify_aggregate(&proof, &g, batch_digest(&owners)).expect("valid aggregate must verify");
    }

    // GATE — aggregate containing ONE forged (non-member) statement fails to prove.
    #[test]
    #[should_panic]
    fn aggregate_with_one_forged_fails() {
        let mut owners = valid_owners();
        owners[3] = (999, 999, 904); // (999,999) is NOT in the group → membership fails on row 3
        let g = group();
        let _ = prove_aggregate(&owners, &g);
    }

    // Binding: a valid proof must not verify against a wrong batch digest.
    #[test]
    fn wrong_digest_rejected() {
        let owners = valid_owners();
        let g = group();
        let proof = prove_aggregate(&owners, &g);
        let bad = batch_digest(&owners) + Val::from_u64(1);
        assert!(verify_aggregate(&proof, &g, bad).is_err(), "wrong digest must not verify");
    }
}
