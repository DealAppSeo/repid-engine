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
//! ## Hash (in-AIR) — Poseidon2-BabyBear (backlog 4.0-d.3)
//! `H_p2(a, b) := Perm16([a, b, 0, …, 0])[0]` — the width-16 Poseidon2 permutation
//! over BabyBear with the published Horizen-Labs round constants, absorbing the two
//! scalars in lanes 0/1 and reading lane 0. The single off-circuit definition lives in
//! [`poseidon2_hash2::h_p2_field`]; the KAT oracle (`kat/poseidon2_babybear16_2to1_kat.json`)
//! and the TypeScript port are gated against it.
//!
//! The in-AIR constraints are **not hand-rolled**: they come from the audited
//! `p3-poseidon2-air` 0.3.0 `Poseidon2Air` gadget at the same pinned 0.3.0 family, fed
//! `RoundConstants` built from `BABYBEAR_RC16_*` — the *same* constants
//! `default_babybear_poseidon2_16()` uses, so in-AIR and off-circuit agree by
//! construction. `circuit_matches_off_circuit_h_p2` in the test module is the gate.
//!
//! This replaces the previous hand-written MiMC (`x^7`, R=12, Miyaguchi–Preneel),
//! which was flagged in the crate's own scope note as non-production.
//!
//! Zero-knowledge comes from the **hiding** FRI PCS (`HidingFriPcs` +
//! `MerkleTreeHidingMmcs`), reused verbatim from the PR #95 machinery.
//!
//! ## Honest scope / next steps (NOT done here — see README)
//! - Membership uses a vanishing-polynomial product over a small public set
//!   (degree = group size). Production should use a Merkle tree (log-depth path)
//!   for large groups.
//! - The hash is now Poseidon2 with audited constants (4.0-d.3). Remaining: the field
//!   is still BabyBear (~31 bits) — soundness rests on the FRI/extension parameters,
//!   not the base field, but a larger field remains the conservative production choice.
//! - FRI uses `create_test_fri_params` (low blowup): correct for the correctness
//!   gate + benchmark, not production soundness.
//! - Court-order reveal (D-020): the human↔commitment link is sealed off-circuit
//!   (encrypted to a custodian/court key); this circuit proves control anonymously,
//!   the reveal is a custodian decryption gated by court order. No circuit change.

use core::borrow::Borrow;

use p3_air::{Air, AirBuilder, AirBuilderWithPublicValues, BaseAir};
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

/// Canonical off-circuit Poseidon2-BabyBear 2-scalar hash `H_p2` (backlog 4.0-d.1).
/// Since 4.0-d.3 this is also the in-clear witness generator for `OwnershipAir`, so
/// circuit and off-circuit share one definition.
pub mod poseidon2_hash2;

use poseidon2_hash2::h_p2_field;

/// Public group size (number of registered commitments). Demo/gate value.
pub const GROUP_SIZE: usize = 4;

// ---- Poseidon2 instance (must match `default_babybear_poseidon2_16()`) --------
/// Permutation width. 16 lanes; the 2-scalar hash absorbs in lanes 0/1.
pub const P2_WIDTH: usize = 16;
/// S-box degree. `x^7` — the minimal permutation exponent for BabyBear
/// (`p − 1 = 2^27 · 3 · 5`, so `x^5` is not a permutation).
pub const P2_SBOX_DEGREE: u64 = 7;
/// Helper columns per S-box. 1 commits `x^3` and keeps every constraint at degree ≤ 3.
pub const P2_SBOX_REGISTERS: usize = 1;
/// Full rounds per half (4 initial + 4 final = 8 full rounds).
pub const P2_HALF_FULL_ROUNDS: usize = 4;
/// Partial rounds for the BabyBear width-16 instance.
pub const P2_PARTIAL_ROUNDS: usize = 13;

/// Trace height. Row 0 is the leaf permutation, every later row the nullifier
/// permutation (identical, so the transition constraints are satisfied uniformly).
///
/// The statement itself needs only 2 rows, but FRI imposes a floor:
/// `p3-fri` prover.rs:65 asserts `log_min_height > log_final_poly_len + log_blowup`,
/// where `log_min_height` is the smallest folding input — NOT `log2(HEIGHT)` directly.
///
/// Measured, not derived (an earlier comment here claimed 8 was the floor; that was
/// wrong): HEIGHT=2 panics at that assertion, HEIGHT=4 is legal and passes the full
/// suite (prove ~3.0ms, proof 19,014 B vs 8's ~5.3ms / 19,734 B).
///
/// 8 is kept deliberately. The win is ~2ms on a circuit with no call sites outside
/// this crate, and lowering a FRI-adjacent parameter belongs in its own change with
/// its own soundness note — not folded into a hardening pass. Also unchanged from
/// the MiMC version, so the height is not a regression either way.
const HEIGHT: usize = 8;

type LinearLayers = GenericPoseidon2LinearLayersBabyBear;
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

/// Trace width = the gadget's own column count. The ownership glue adds **no**
/// columns: `secret`/`agent_id`/`context` are the permutation input lanes and
/// `leaf`/`nullifier` are its output lanes.
const W: usize = num_cols::<
    P2_WIDTH,
    P2_SBOX_DEGREE,
    P2_SBOX_REGISTERS,
    P2_HALF_FULL_ROUNDS,
    P2_PARTIAL_ROUNDS,
>();

/// The published Horizen-Labs BabyBear width-16 round constants — **the same ones**
/// `default_babybear_poseidon2_16()` (and therefore `h_p2`) uses. Feeding the gadget a
/// different set would silently break circuit↔off-circuit parity; that is the single
/// highest-risk integration point, gated by `circuit_matches_off_circuit_h_p2`.
fn p2_round_constants() -> P2Constants {
    P2Constants::new(
        BABYBEAR_RC16_EXTERNAL_INITIAL,
        BABYBEAR_RC16_INTERNAL,
        BABYBEAR_RC16_EXTERNAL_FINAL,
    )
}

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

// ---- H_p2 in the clear (witness generation) ----------------------------------

/// Identity commitment for an owner: `C = H_p2(secret, agent_id)`.
pub fn commitment(secret: u64, agent_id: u64) -> Val {
    h_p2_field(Val::from_u64(secret), Val::from_u64(agent_id))
}

/// Per-context nullifier: `N = H_p2(secret, context)`.
pub fn nullifier(secret: u64, context: u64) -> Val {
    h_p2_field(Val::from_u64(secret), Val::from_u64(context))
}

// ---- AIR ---------------------------------------------------------------------

/// The ownership statement, built on the audited `Poseidon2Air` gadget.
///
/// Every trace row **is** one Poseidon2 permutation (the gadget's own column layout),
/// so the round constraints are the audited ones verbatim — nothing about the
/// permutation is re-derived here. The ownership statement is expressed purely as
/// boundary/transition constraints over the permutation's input and output lanes:
///
/// | row | permutation | inputs | output lane 0 |
/// |---|---|---|---|
/// | 0 (first) | leaf | `[secret, agent_id, 0…]` | `leaf`, constrained ∈ `{C_j}` |
/// | 1.. | nullifier | `[secret, context, 0…]` | must equal the public nullifier |
///
/// The transition constraint carries `secret` from the leaf row into the nullifier
/// row, which is what binds the two hashes to the *same* human.
pub struct OwnershipAir {
    p2: P2Air,
}

impl OwnershipAir {
    pub fn new() -> Self {
        Self {
            p2: P2Air::new(p2_round_constants()),
        }
    }
}

impl Default for OwnershipAir {
    fn default() -> Self {
        Self::new()
    }
}

impl BaseAir<Val> for OwnershipAir {
    fn width(&self) -> usize {
        W
    }
}

impl<AB> Air<AB> for OwnershipAir
where
    AB: AirBuilderWithPublicValues<F = Val>,
    LinearLayers: GenericPoseidon2LinearLayers<AB::Expr, P2_WIDTH>,
{
    fn eval(&self, builder: &mut AB) {
        // 1. The audited Poseidon2 round constraints, applied to every row.
        //    (`Poseidon2Air::eval` borrows the whole row as `Poseidon2Cols`, which is
        //    exactly why the trace width is `num_cols` and the glue adds no columns.)
        self.p2.eval(builder);

        // 2. Copy out the public vars (they are `Copy`) so the immutable borrow of
        //    `builder` from `public_values()` ends before the mutable assert_* calls.
        let (context_pv, null_pv, group_pv) = {
            let pis = builder.public_values();
            let group: Vec<AB::PublicVar> = (0..GROUP_SIZE).map(|j| pis[2 + j]).collect();
            (pis[0], pis[1], group)
        };
        let context: AB::Expr = context_pv.into();
        let null_pub: AB::Expr = null_pv.into();

        let (local, next) = {
            let main = builder.main();
            let local_row = main.row_slice(0).expect("trace has no rows");
            let next_row = main.row_slice(1).expect("trace has no next row");
            let local: &P2Cols<AB::Var> = (*local_row).borrow();
            let next: &P2Cols<AB::Var> = (*next_row).borrow();
            (local_to_owned(local), local_to_owned(next))
        };

        // 3. First row = the LEAF permutation: lanes 2.. are the zero padding of the
        //    2-scalar hash, and its output must be a member of the public group.
        {
            let mut first = builder.when_first_row();
            for lane in 2..P2_WIDTH {
                first.assert_zero(local.inputs[lane].clone());
            }
            // Membership: ∏_j (leaf − C_j) == 0. `leaf` is never a public input, so
            // *which* member the prover is stays hidden.
            let leaf: AB::Expr = local.out0.clone();
            let mut prod: AB::Expr = leaf.clone() - group_pv[0].into();
            for j in 1..GROUP_SIZE {
                prod = prod * (leaf.clone() - group_pv[j].into());
            }
            first.assert_zero(prod);
        }

        // 4. Every subsequent row = the NULLIFIER permutation on the SAME secret.
        {
            let mut trans = builder.when_transition();
            // The binding that makes the statement sound: same `secret` lane.
            trans.assert_eq(next.inputs[0].clone(), local.inputs[0].clone());
            trans.assert_eq(next.inputs[1].clone(), context.clone());
            for lane in 2..P2_WIDTH {
                trans.assert_zero(next.inputs[lane].clone());
            }
            trans.assert_eq(next.out0.clone(), null_pub.clone());
        }
    }
}

/// The handful of lanes the ownership glue actually reads, lifted out of the
/// gadget's column struct into owned expressions (the borrow of `builder.main()`
/// must end before any `assert_*`).
struct Lanes<E> {
    inputs: Vec<E>,
    out0: E,
}

fn local_to_owned<V: Copy + Into<E>, E: Clone>(cols: &P2Cols<V>) -> Lanes<E> {
    Lanes {
        inputs: cols.inputs.iter().map(|v| (*v).into()).collect(),
        out0: cols.ending_full_rounds[P2_HALF_FULL_ROUNDS - 1].post[0].into(),
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
    // log_blowup=3 (blowup 8) so the LDE covers the quotient domain. Inherited from
    // the MiMC version, whose x^7 S-box gave degree-7 constraints; the Poseidon2
    // gadget with SBOX_REGISTERS=1 is degree <= 3, so this blowup is now more
    // headroom than the constraints need. Left as-is: it is conservative (higher
    // blowup = better FRI soundness per query), and tightening it is a proving-cost
    // optimisation that belongs with the HEIGHT question above, not here.
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

/// Build the witness with the gadget's own trace generator, so the committed columns
/// are by construction the ones its constraints expect.
///
/// Row 0 absorbs `(secret, agent_id)` → leaf; rows 1.. absorb `(secret, context)` →
/// nullifier. Every row is a full permutation, which is why `HEIGHT` is kept minimal.
fn generate_trace(secret: u64, agent_id: u64, context: u64) -> RowMajorMatrix<Val> {
    let pad = |a: u64, b: u64| {
        let mut lanes = [Val::ZERO; P2_WIDTH];
        lanes[0] = Val::from_u64(a);
        lanes[1] = Val::from_u64(b);
        lanes
    };

    let mut inputs = Vec::with_capacity(HEIGHT);
    inputs.push(pad(secret, agent_id));
    for _ in 1..HEIGHT {
        inputs.push(pad(secret, context));
    }

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
    prove(&config, &OwnershipAir::new(), trace, &public_values(context, n, group))
}

/// Verify an ownership proof. Verifier learns only `(context, nullifier, group)`.
pub fn verify_ownership(
    proof: &Proof<VaultConfig>,
    context: u64,
    nullifier: Val,
    group: &[Val; GROUP_SIZE],
) -> Result<(), VerificationError<impl core::fmt::Debug>> {
    let config = make_config();
    verify(&config, &OwnershipAir::new(), proof, &public_values(context, nullifier, group))
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
    use p3_field::PrimeField32;
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

    // GATE 0 (4.0-d.3 make-or-break) — the CIRCUIT and the OFF-CIRCUIT hash must agree.
    //
    // If the in-AIR permutation ever drifts from `h_p2` (wrong round constants, wrong
    // linear layer, wrong lane convention), a proof would still verify against its own
    // trace while failing against a commitment set computed off-circuit — the exact
    // silent-break ZKP_ARCHITECTURE_INVARIANTS Inv 1 warns about. This reads the real
    // witness the prover commits to and compares it with the frozen definition.
    #[test]
    fn circuit_matches_off_circuit_h_p2() {
        for (secret, agent_id, context) in
            [(777u64, 555u64, 9001u64), (1, 2, 3), (0, 0, 0), (123456789, 987654321, 42)]
        {
            let trace = generate_trace(secret, agent_id, context);

            let leaf_row = trace.row_slice(0).expect("leaf row");
            let leaf_cols: &P2Cols<Val> = (*leaf_row).borrow();
            let null_row = trace.row_slice(1).expect("nullifier row");
            let null_cols: &P2Cols<Val> = (*null_row).borrow();

            // The witness the AIR constrains == the value the group set is built from.
            assert_eq!(
                leaf_cols.ending_full_rounds[P2_HALF_FULL_ROUNDS - 1].post[0],
                commitment(secret, agent_id),
                "in-AIR leaf != off-circuit commitment for ({secret}, {agent_id})"
            );
            assert_eq!(
                null_cols.ending_full_rounds[P2_HALF_FULL_ROUNDS - 1].post[0],
                nullifier(secret, context),
                "in-AIR nullifier != off-circuit nullifier for ({secret}, {context})"
            );

            // The 2-scalar convention: absorb in lanes 0/1, zero-pad the rest. The AIR
            // constrains lanes 2.. to zero, so a drift here would make traces unprovable
            // rather than silently wrong — assert it anyway so the intent is pinned.
            assert_eq!(leaf_cols.inputs[0], Val::from_u64(secret));
            assert_eq!(leaf_cols.inputs[1], Val::from_u64(agent_id));
            assert_eq!(null_cols.inputs[0], Val::from_u64(secret));
            assert_eq!(null_cols.inputs[1], Val::from_u64(context));
            for lane in 2..P2_WIDTH {
                assert_eq!(leaf_cols.inputs[lane], Val::ZERO, "leaf lane {lane} not padded");
                assert_eq!(null_cols.inputs[lane], Val::ZERO, "null lane {lane} not padded");
            }
        }
    }

    // GATE 0b — the crate-level `h_p2` (what the KAT oracle commits, and what the TS
    // port is gated against) is the SAME function the circuit's witness uses. Guards
    // against the u32/field wrappers diverging.
    #[test]
    fn commitment_agrees_with_kat_level_h_p2() {
        for (a, b) in [(0u32, 0u32), (1, 2), (777, 555), (2013265920, 123456789)] {
            assert_eq!(
                commitment(a as u64, b as u64).as_canonical_u32(),
                poseidon2_hash2::h_p2(a, b),
                "commitment() diverged from the KAT-gated h_p2 for ({a}, {b})"
            );
        }
    }

    // GATE 0c (4.0-d.3 soundness) — the ONE new mechanism this rewrite introduces.
    //
    // Under MiMC both hashes shared a literal `secret` cell on a single row. Poseidon2
    // needs one permutation per row, so the binding moved to a transition constraint
    // (`next.inputs[0] == local.inputs[0]`). If that constraint were missing or wrong, a
    // prover could prove membership with one human's secret while emitting a *different*
    // human's nullifier — defeating double-action detection entirely. Forge exactly that
    // trace and require the prover to reject it.
    // Mutation-tested: deleting the `next.inputs[0] == local.inputs[0]` constraint makes
    // this forgery *provable*, so the test really does gate that one line.
    #[test]
    #[should_panic(expected = "constraints had nonzero value")]
    fn nullifier_must_use_the_same_secret_as_the_leaf() {
        let (secret, agent_id, context) = (777u64, 555u64, 9001u64);
        let impostor_secret = 888u64;
        let group = group_with(secret, agent_id);

        let pad = |a: u64, b: u64| {
            let mut lanes = [Val::ZERO; P2_WIDTH];
            lanes[0] = Val::from_u64(a);
            lanes[1] = Val::from_u64(b);
            lanes
        };
        // Row 0 is a genuine member leaf; rows 1.. hash a DIFFERENT secret.
        let mut inputs = vec![pad(secret, agent_id)];
        for _ in 1..HEIGHT {
            inputs.push(pad(impostor_secret, context));
        }
        let forged = generate_trace_rows::<
            Val,
            LinearLayers,
            P2_WIDTH,
            P2_SBOX_DEGREE,
            P2_SBOX_REGISTERS,
            P2_HALF_FULL_ROUNDS,
            P2_PARTIAL_ROUNDS,
        >(inputs, &p2_round_constants(), 0);

        // Publish the impostor's nullifier, so only the secret-binding constraint stands
        // between this trace and a valid-looking proof.
        let config = make_config();
        let n = nullifier(impostor_secret, context);
        let _ = prove(
            &config,
            &OwnershipAir::new(),
            forged,
            &public_values(context, n, &group),
        );
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
            "[zkp-vault bench] prove={:.1}ms verify={:.1}ms proof_size={} bytes (hash=poseidon2-babybear16, width={}, group={}, height={})",
            prove_ms, verify_ms, bytes.len(), W, GROUP_SIZE, HEIGHT
        );
    }
}
