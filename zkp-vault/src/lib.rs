//! # zkp-vault — anonymous-ownership ZK vault (Plonky3)
//!
//! Replaces the TypeScript Plonky3 stub (`src/zkp/plonky3-stub.ts`,
//! `src/zkp/plonky3-real.ts`) with a genuine STARK. The TS bridge stays as the
//! interface/contract; this crate is the real cryptography behind it.
//!
//! ## Why this statement (DECISION_LOG D-019 / D-020)
//!
//! Reputation (RepID) is **public** on-chain via ERC-8004 — proving it in ZK is
//! redundant. The real privacy need is **human-anonymous ownership**: prove you
//! control the secret behind an agent's registered identity **without revealing
//! which human you are**, with a court-order-only reveal path (D-020).
//!
//! This is a Semaphore-style statement. **No reputation values appear in the
//! circuit.**
//!
//! ## The statement
//!
//! - **Public inputs:** `context`, a `nullifier`, and the group's public
//!   commitment set `{C_0..C_{M-1}}` (the registered agent-identity commitments).
//! - **Private witness:** the owner `secret` and `agent_id` — never revealed.
//! - **Proof shows:**
//!   1. `leaf = H(secret, agent_id)` is one of the public commitments
//!      (`∏_j (leaf − C_j) = 0`) — i.e. the prover controls a *registered*
//!      identity, **without disclosing which one**;
//!   2. `nullifier = H(secret, context)` is correctly derived.
//!
//! ### Nullifier semantics (P1.2)
//! The nullifier is `H(secret, context)` — one per `(human, context)`:
//! - **Unlinkable across contexts:** different `context` ⇒ different nullifier;
//!   the leaf (the human's identity) never enters the public inputs, and the only
//!   shared public value between two proofs is the group set (common to *all*
//!   members), so two actions by the same human in different contexts cannot be
//!   linked.
//! - **Double-action detectable within a context:** same `(secret, context)` ⇒
//!   identical nullifier, so a registry can reject a second action in that context.
//!
//! ## Hash (in-AIR)
//! MiMC with the S-box `x^7`. For BabyBear, `p − 1 = 2^27 · 3 · 5`, so the minimal
//! permutation exponent coprime to `p − 1` is 7 (`x^5` is NOT a permutation here).
//! `H(a, b) = perm(a, b) + a + b` (Miyaguchi–Preneel style), `perm` = R MiMC rounds.
//!
//! Zero-knowledge comes from the **hiding** FRI PCS (`HidingFriPcs` +
//! `MerkleTreeHidingMmcs`), reused verbatim from the PR #95 machinery.
//!
//! ## Honest scope / next steps (NOT done here — see README)
//! - Membership uses a vanishing-polynomial product over a small public set
//!   (degree = group size). Production should use a Merkle tree (log-depth path)
//!   for large groups.
//! - MiMC over BabyBear gives ~field-size security; production should use Poseidon2
//!   over a larger field and audited round constants/counts.
//! - FRI uses `create_test_fri_params` (low blowup): correct for the correctness
//!   gate + benchmark, not production soundness.
//! - Court-order reveal (D-020): the human↔commitment link is sealed off-circuit
//!   (encrypted to a custodian/court key); this circuit proves control anonymously,
//!   the reveal is a custodian decryption gated by court order. No circuit change.

use p3_air::{Air, AirBuilderWithPublicValues, BaseAir};
use p3_baby_bear::BabyBear;
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
use p3_symmetric::{CompressionFunctionFromHasher, PaddingFreeSponge, SerializingHasher};
use p3_uni_stark::{prove, verify, Proof, StarkConfig, VerificationError};
use rand::rngs::SmallRng;
use rand::SeedableRng;

/// Canonical off-circuit Poseidon2-BabyBear 2-scalar hash (backlog 4.0-d.1). Not yet
/// used by `OwnershipAir` — the in-AIR swap from MiMC is backlog 4.0-d.3; this is the
/// frozen definition that rewrite must reproduce bit-for-bit.
pub mod poseidon2_hash2;

/// MiMC rounds. ≥ ceil(log_7(p)) ≈ 11 for full security over BabyBear; 12 here.
pub const R: usize = 12;
/// Public group size (number of registered commitments). Demo/gate value.
pub const GROUP_SIZE: usize = 4;
/// Trace height (power of two). The statement is single-row; we replicate it.
const HEIGHT: usize = 8;

// Column layout (width = 2R + 3):
//   [0] secret  [1] agent_id
//   [2 ..= R+1]      leaf MiMC states  L_1..L_R      (L_0 = secret)
//   [R+2 ..= 2R+1]   nullifier MiMC states N_1..N_R  (N_0 = secret)
//   [2R+2]           leaf
const W: usize = 2 * R + 3;
const LEAF_COL: usize = 2 * R + 2;

/// MiMC round constants (same u64 seeds used in-trace and in-AIR).
const RC: [u64; R] = [
    0x6d6f_6e65, 0x726f_3031, 0x9e37_79b1, 0x1234_5678, 0xabcd_ef01, 0x0f0f_0f0f, 0xdead_beef,
    0xfeed_face, 0xc0ff_ee11, 0x5a5a_a5a5, 0x1357_9bdf, 0x2468_ace0,
];

// ---- Plonky3 config (BabyBear + Keccak hiding MMCS + hiding FRI PCS) ----------
// Reused verbatim from PR #95 (Plonky3's own test_zk construction).
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

// ---- MiMC in the clear (witness generation) ----------------------------------
#[inline]
fn pow7(x: Val) -> Val {
    let x2 = x * x;
    let x4 = x2 * x2;
    x4 * x2 * x
}

/// MiMC permutation states `L_1..L_R` for input `inp` with key `key`.
fn mimc_states(inp: Val, key: Val) -> [Val; R] {
    let mut st = [Val::ZERO; R];
    let mut x = inp;
    for r in 0..R {
        x = pow7(x + key + Val::from_u64(RC[r]));
        st[r] = x;
    }
    st
}

/// `H(a, b) = perm(a, b) + a + b` (Miyaguchi–Preneel style).
fn mimc_hash(a: Val, b: Val) -> Val {
    let st = mimc_states(a, b);
    st[R - 1] + a + b
}

/// Identity commitment for an owner: `C = H(secret, agent_id)`.
pub fn commitment(secret: u64, agent_id: u64) -> Val {
    mimc_hash(Val::from_u64(secret), Val::from_u64(agent_id))
}

/// Per-context nullifier: `N = H(secret, context)`.
pub fn nullifier(secret: u64, context: u64) -> Val {
    mimc_hash(Val::from_u64(secret), Val::from_u64(context))
}

// ---- AIR ---------------------------------------------------------------------
pub struct OwnershipAir;

impl<F> BaseAir<F> for OwnershipAir {
    fn width(&self) -> usize {
        W
    }
}

impl<AB: AirBuilderWithPublicValues> Air<AB> for OwnershipAir {
    fn eval(&self, builder: &mut AB) {
        let main = builder.main();
        let row = main.row_slice(0).expect("trace has no rows");

        // Copy out the public vars (Copy) so the immutable borrow of `builder`
        // from public_values() ends before the mutable assert_* calls below.
        let (context_pv, null_pv, group_pv) = {
            let pis = builder.public_values();
            let group: Vec<AB::PublicVar> = (0..GROUP_SIZE).map(|j| pis[2 + j]).collect();
            (pis[0], pis[1], group)
        };
        let context: AB::Expr = context_pv.into();
        let null_pub: AB::Expr = null_pv.into();

        let secret: AB::Expr = row[0].into();
        let agent_id: AB::Expr = row[1].into();

        let pow7 = |e: AB::Expr| -> AB::Expr {
            let e2 = e.clone() * e.clone();
            let e4 = e2.clone() * e2.clone();
            e4 * e2 * e
        };

        // Leaf MiMC rounds: L_0 = secret, L_{r+1} = (L_r + agent_id + RC[r])^7.
        for r in 0..R {
            let prev: AB::Expr = if r == 0 {
                secret.clone()
            } else {
                row[1 + r].into() // L_r at index 2+(r-1) = 1+r
            };
            let cur: AB::Expr = row[2 + r].into(); // L_{r+1} at index 2+r
            let rc = AB::Expr::from(AB::F::from_u64(RC[r]));
            builder.assert_eq(cur, pow7(prev + agent_id.clone() + rc));
        }
        // leaf = L_R + secret + agent_id  (L_R at index R+1)
        let l_last: AB::Expr = row[R + 1].into();
        let leaf: AB::Expr = row[LEAF_COL].into();
        builder.assert_eq(leaf.clone(), l_last + secret.clone() + agent_id);

        // Nullifier MiMC rounds: N_0 = secret, N_{r+1} = (N_r + context + RC[r])^7.
        for r in 0..R {
            let prev: AB::Expr = if r == 0 {
                secret.clone()
            } else {
                row[R + 1 + r].into() // N_r at index (R+2)+(r-1) = R+1+r
            };
            let cur: AB::Expr = row[R + 2 + r].into(); // N_{r+1} at index (R+2)+r
            let rc = AB::Expr::from(AB::F::from_u64(RC[r]));
            builder.assert_eq(cur, pow7(prev + context.clone() + rc));
        }
        // nullifier(public) = N_R + secret + context  (N_R at index 2R+1)
        let n_last: AB::Expr = row[2 * R + 1].into();
        builder.assert_eq(null_pub, n_last + secret + context);

        // Membership: ∏_j (leaf - C_j) == 0  (leaf is one of the public commitments).
        let mut prod: AB::Expr = leaf.clone() - group_pv[0].into();
        for j in 1..GROUP_SIZE {
            prod = prod * (leaf.clone() - group_pv[j].into());
        }
        builder.assert_zero(prod);
    }
}

// ---- prove / verify ----------------------------------------------------------
fn make_config() -> VaultConfig {
    let byte_hash = ByteHash {};
    let u64_hash = U64Hash::new(KeccakF {});
    let field_hash = FieldHash::new(u64_hash);
    let compress = MyCompress::new(u64_hash);
    let val_mmcs = ValHidingMmcs::new(field_hash, compress, SmallRng::seed_from_u64(1));
    let challenge_mmcs = ChallengeHidingMmcs::new(val_mmcs.clone());
    let dft = Dft::default();
    // log_blowup=3 (blowup 8) so the LDE covers the quotient domain for our
    // degree-7 MiMC constraints (default test params use log_blowup=2, max deg 5).
    let fri_params = FriParameters {
        log_blowup: 3,
        log_final_poly_len: 2,
        num_queries: 2,
        proof_of_work_bits: 1,
        mmcs: challenge_mmcs,
    };
    let pcs = HidingPcs::new(dft, val_mmcs, fri_params, 4, SmallRng::seed_from_u64(1));
    let challenger = Challenger::from_hasher(vec![], byte_hash);
    VaultConfig::new(pcs, challenger)
}

fn generate_trace(secret: u64, agent_id: u64, context: u64) -> RowMajorMatrix<Val> {
    let s = Val::from_u64(secret);
    let aid = Val::from_u64(agent_id);
    let ctx = Val::from_u64(context);
    let l_states = mimc_states(s, aid);
    let n_states = mimc_states(s, ctx);
    let leaf = l_states[R - 1] + s + aid;

    let mut one = Vec::with_capacity(W);
    one.push(s);
    one.push(aid);
    one.extend_from_slice(&l_states);
    one.extend_from_slice(&n_states);
    one.push(leaf);
    debug_assert_eq!(one.len(), W);

    let mut values = Vec::with_capacity(W * HEIGHT);
    for _ in 0..HEIGHT {
        values.extend_from_slice(&one);
    }
    RowMajorMatrix::new(values, W)
}

fn public_values(context: u64, nullifier: Val, group: &[Val; GROUP_SIZE]) -> Vec<Val> {
    let mut pis = vec![Val::from_u64(context), nullifier];
    pis.extend_from_slice(group);
    pis
}

/// Prove control of a registered identity for `context`, anonymously.
/// `group` must contain `commitment(secret, agent_id)`.
pub fn prove_ownership(
    secret: u64,
    agent_id: u64,
    context: u64,
    group: &[Val; GROUP_SIZE],
) -> Proof<VaultConfig> {
    let config = make_config();
    let trace = generate_trace(secret, agent_id, context);
    let n = nullifier(secret, context);
    prove(&config, &OwnershipAir, trace, &public_values(context, n, group))
}

/// Verify an ownership proof. Verifier learns only `(context, nullifier, group)`.
pub fn verify_ownership(
    proof: &Proof<VaultConfig>,
    context: u64,
    nullifier: Val,
    group: &[Val; GROUP_SIZE],
) -> Result<(), VerificationError<impl core::fmt::Debug>> {
    let config = make_config();
    verify(&config, &OwnershipAir, proof, &public_values(context, nullifier, group))
}

pub fn proof_to_bytes(proof: &Proof<VaultConfig>) -> Vec<u8> {
    bincode::serialize(proof).expect("proof serialization")
}

pub fn proof_from_bytes(bytes: &[u8]) -> Result<Proof<VaultConfig>, bincode::Error> {
    bincode::deserialize(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    // A group whose member #1 is the real owner; others are arbitrary commitments.
    fn group_with(secret: u64, agent_id: u64) -> [Val; GROUP_SIZE] {
        [
            commitment(11, 101),
            commitment(secret, agent_id), // the real member (index hidden in-proof)
            commitment(33, 303),
            commitment(44, 404),
        ]
    }

    // GATE 1 — accept a valid owner proof.
    #[test]
    fn valid_owner_accepts() {
        let (secret, agent_id, context) = (777, 555, 9001);
        let group = group_with(secret, agent_id);
        let proof = prove_ownership(secret, agent_id, context, &group);
        verify_ownership(&proof, context, nullifier(secret, context), &group)
            .expect("valid owner proof must verify");
    }

    // GATE 2a — reject a FORGERY: claim the wrong nullifier for a real proof.
    #[test]
    fn forged_nullifier_rejected() {
        let (secret, agent_id, context) = (777, 555, 9001);
        let group = group_with(secret, agent_id);
        let proof = prove_ownership(secret, agent_id, context, &group);
        let wrong = nullifier(secret, context) + Val::from_u64(1);
        assert!(
            verify_ownership(&proof, context, wrong, &group).is_err(),
            "a wrong nullifier must not verify"
        );
    }

    // GATE 2b — reject a FORGERY: a non-member (secret not in the group) cannot prove.
    // Membership product ≠ 0 → check_constraints rejects (debug), mirroring Plonky3.
    #[test]
    #[should_panic]
    fn non_member_is_unprovable() {
        let context = 9001;
        let group = group_with(777, 555); // real owner is (777,555)
        let _ = prove_ownership(12345, 67890, context, &group); // not a member
    }

    // GATE 2c — reject a TAMPERED proof.
    #[test]
    fn tampered_proof_rejected() {
        let (secret, agent_id, context) = (777, 555, 9001);
        let group = group_with(secret, agent_id);
        let proof = prove_ownership(secret, agent_id, context, &group);
        let n = nullifier(secret, context);
        let mut bytes = proof_to_bytes(&proof);
        verify_ownership(&proof_from_bytes(&bytes).unwrap(), context, n, &group)
            .expect("clean round-trip verifies");
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xFF;
        let rejected = match proof_from_bytes(&bytes) {
            Err(_) => true,
            Ok(t) => verify_ownership(&t, context, n, &group).is_err(),
        };
        assert!(rejected, "a tampered proof must be rejected");
    }

    // GATE 3 — UNLINKABILITY: same human, two contexts → different nullifiers, and
    // the only shared public value is the group set (common to all members).
    #[test]
    fn unlinkable_across_contexts() {
        let (secret, agent_id) = (777, 555);
        let group = group_with(secret, agent_id);
        let (ctx_a, ctx_b) = (1000, 2000);

        let proof_a = prove_ownership(secret, agent_id, ctx_a, &group);
        let proof_b = prove_ownership(secret, agent_id, ctx_b, &group);
        let n_a = nullifier(secret, ctx_a);
        let n_b = nullifier(secret, ctx_b);

        verify_ownership(&proof_a, ctx_a, n_a, &group).expect("proof A verifies");
        verify_ownership(&proof_b, ctx_b, n_b, &group).expect("proof B verifies");

        // The public nullifiers differ → the two actions cannot be linked by nullifier.
        assert_ne!(n_a, n_b, "nullifiers across contexts must differ (unlinkable)");
        // The leaf (the human's identity) is NOT a public input — nothing else links them.
        // (group is identical and shared by every member, so it is not a linking signal.)
    }

    // Double-action WITHIN a context is detectable: same (secret, context) → same nullifier.
    #[test]
    fn double_action_detectable_in_context() {
        let (secret, context) = (777, 9001);
        assert_eq!(
            nullifier(secret, context),
            nullifier(secret, context),
            "same (human, context) must yield the same nullifier (double-action detectable)"
        );
        // A different human in the same context gets a different nullifier.
        assert_ne!(nullifier(secret, context), nullifier(888, context));
    }

    // Benchmark (run: cargo test --release bench -- --nocapture).
    #[test]
    fn bench_prove_verify() {
        let (secret, agent_id, context) = (777, 555, 9001);
        let group = group_with(secret, agent_id);
        let t0 = Instant::now();
        let proof = prove_ownership(secret, agent_id, context, &group);
        let prove_ms = t0.elapsed().as_secs_f64() * 1e3;
        let bytes = proof_to_bytes(&proof);
        let n = nullifier(secret, context);
        let t1 = Instant::now();
        verify_ownership(&proof, context, n, &group).expect("verify");
        let verify_ms = t1.elapsed().as_secs_f64() * 1e3;
        eprintln!(
            "[zkp-vault bench] prove={:.1}ms verify={:.1}ms proof_size={} bytes (R={}, group={}, height={})",
            prove_ms, verify_ms, bytes.len(), R, GROUP_SIZE, HEIGHT
        );
    }
}
