//! `recursion_spike` — the SMALLEST recursion experiment at the pin.
//!
//! Deliverable (3): attempt the minimal recursion primitive — express a Plonky3
//! verifier *inside* a circuit (verify-a-proof-inside-a-proof) — and either make it
//! compile+run or fail with an EXACT error that names the missing capability.
//!
//! ## Result, stated plainly
//!
//! At the canonical pin (`p3-* 0.3.0`) there is **NO in-circuit verifier**. The
//! `p3_uni_stark::verify` function is a NATIVE Rust verifier: it consumes a concrete
//! `Proof<SC>` and evaluates the AIR constraints over concrete field elements
//! (`Val<SC>` / `Challenge`), driving a concrete Keccak-bytes challenger
//! (`SerializingChallenger32<Val, HashChallenger<u8, Keccak256Hash, 32>>`). None of
//! its machinery is generic over an `AirBuilder` expression type (`AB::Expr`), so the
//! verifier's own checks cannot be re-expressed as AIR constraints. That is exactly
//! what recursion requires.
//!
//! ### What is missing, concretely (the capability map)
//! To build "verify a proof inside a proof" you need all three, none of which ship at
//! the 0.3.0 pin:
//!   1. A SYMBOLIC / in-circuit CHALLENGER — a Fiat–Shamir transcript whose observe/
//!      sample operate over `AB::Expr`, not over `u8`/`Val`. The pin's challenger
//!      hashes bytes with Keccak; there is no arithmetized (Poseidon2-sponge)
//!      challenger exposed as an AIR gadget.
//!   2. A SYMBOLIC PCS-OPENING verifier — FRI query/fold checks (`p3_fri::verify_fri`)
//!      expressed as constraints. `verify_fri` is a native `fn` over concrete
//!      `Challenge`; there is no AIR form.
//!   3. A VERIFIER-AS-AIR (an `Air` whose `eval` enforces 1+2 for an inner proof).
//!      Absent.
//!
//! ### Crate availability (measured, not asserted)
//!   - The `p3-*` crates published to crates.io at the 0.3.0 pin family expose **no**
//!     recursion crate (`p3-recursion`, `p3-verifier`, `p3-circuit`, … are absent).
//!   - crates.io DOES host a name `p3-recursion`, but only at `0.1.0`, and it is an
//!     EMPTY PLACEHOLDER: its entire source is `pub fn foo() { todo!() }` with zero
//!     dependencies. It is a name reservation, not a verifier.
//!   - Real Plonky3 recursion lives in the upstream Plonky3 git monorepo, decoupled
//!     from the crates.io 0.3.0 release, and is not pinnable here without a git
//!     dependency + a version bump off 0.3.0.
//!
//! ### Smallest next experiment (named, not done here)
//! Two honest paths, in increasing order of effort:
//!   (A) STAY on Plonky3 but move off the crates.io 0.3.0 pin: add the upstream
//!       `p3-recursion`/`p3-circuit-builder` as a **git** dependency at a matched
//!       commit, port the leaf AIR to it, and prove `verify(inner_proof)` as an
//!       outer AIR. Cost: a pin bump that touches every p3 crate (Invariant 5 —
//!       "one Plonky3 pin governs all circuits"), so it is a coordinated bump, not a
//!       drop-in. This is the smallest experiment that could yield real recursion.
//!   (B) SWITCH stacks for the aggregation tier: SP1 / Risc0 (RISC-V zkVM, verify a
//!       STARK by running the verifier as a guest program) or Plonky2 (has a native
//!       in-circuit verifier). Larger blast radius; only if (A) stalls.
//!
//! Run the (passing) capability probe:
//!   cargo run --release --example recursion_spike
//! Reproduce the compile-fail primitive (this is the point):
//!   cargo build --example recursion_spike --features attempt_incircuit_verify

use zkp_vault::{
    commitment, nullifier, proof_to_bytes, prove_ownership, verify_ownership, GROUP_SIZE,
};

fn main() {
    println!("== recursion spike @ p3-* 0.3.0 ==\n");

    // --- Baseline: the NATIVE verifier works over concrete field elements. --------
    // This is the thing recursion would have to re-express in-circuit — and cannot.
    let (secret, agent_id, context) = (777u64, 555u64, 9001u64); // SYNTHETIC
    let group = [
        commitment(11, 101),
        commitment(secret, agent_id),
        commitment(33, 303),
        commitment(44, 404),
    ];
    let proof = prove_ownership(secret, agent_id, context, &group);
    let n_pub = nullifier(secret, context);
    verify_ownership(&proof, context, n_pub, &group).expect("native verify");
    println!(
        "[OK] native leaf verify passed  (proof={} bytes, verifier = concrete Rust over Val/Challenge)",
        proof_to_bytes(&proof).len()
    );

    println!(
        "\n[MISSING] in-circuit verifier (verify-a-proof-inside-a-proof):\n\
         \x20 - no symbolic/AIR challenger (pin's challenger hashes bytes with Keccak)\n\
         \x20 - no symbolic PCS: p3_fri::verify_fri is a native fn over concrete Challenge\n\
         \x20 - no verifier-as-AIR gadget\n\
         \x20 - crates.io `p3-recursion` exists only at 0.1.0 = `pub fn foo(){{todo!()}}` (empty stub)\n\
         => group_size={} membership is a degree-N vanishing product, NOT a recursive rollup.\n\
         => the 'fold/aggregate' in TypeScript (delta-anchor.ts) is a Poseidon2 Merkle\n\
         \x20\x20 accumulator (inclusion + timestamp), not verified recursive computation.",
        GROUP_SIZE
    );

    println!(
        "\nSmallest next experiment: add upstream Plonky3 `p3-recursion` as a GIT dep at a\n\
         matched commit (a coordinated pin bump off crates.io 0.3.0 — Invariant 5), port the\n\
         leaf AIR, and prove verify(inner) as an outer AIR. Fallback: SP1/Risc0/Plonky2."
    );

    #[cfg(feature = "attempt_incircuit_verify")]
    incircuit_attempt::run();
}

/// The minimal "verify inside a circuit" attempt. Compiled ONLY under
/// `--features attempt_incircuit_verify`, because it DOES NOT COMPILE — and that
/// compile error is the deliverable. See the exact captured error in
/// `recursion_spike.compile_error.txt` next to this file.
///
/// The essence of the blocker in one line: a verifier's opened values are concrete
/// field elements (`Challenge`), but an AIR constraint is an `AB::Expr`; at this pin
/// nothing lifts one into the other, so you cannot assert a verifier check as a
/// circuit constraint.
#[cfg(feature = "attempt_incircuit_verify")]
mod incircuit_attempt {
    use p3_air::{Air, AirBuilder, BaseAir};
    use p3_baby_bear::BabyBear;
    use p3_field::extension::BinomialExtensionField;
    use p3_matrix::dense::RowMajorMatrix;

    type Challenge = BinomialExtensionField<BabyBear, 4>;

    /// An AIR that tries to do the ONE thing recursion needs: turn a verifier value
    /// (an opened extension-field element from an inner proof) into a circuit
    /// constraint. There is no bridge at the pin, so this cannot type-check.
    struct RecursiveVerifierAir {
        /// Stand-in for a value the inner verifier would produce (a PCS opening).
        opened_value: Challenge,
    }

    impl<F> BaseAir<F> for RecursiveVerifierAir {
        fn width(&self) -> usize {
            1
        }
    }

    impl<AB: AirBuilder> Air<AB> for RecursiveVerifierAir {
        fn eval(&self, builder: &mut AB) {
            // We want to constrain "this opened value equals what the transcript says".
            // But `assert_zero` needs `AB::Expr`, and `self.opened_value` is a concrete
            // `Challenge`. No `From<Challenge> for AB::Expr` exists (and could not — the
            // AIR field is BabyBear, the opening lives in its degree-4 extension), and
            // there is no in-circuit challenger to derive the expected value symbolically.
            //
            // ↓↓↓ THE EXACT MISSING CAPABILITY, as a compile error ↓↓↓
            builder.assert_zero(self.opened_value); // mismatched types: expected AB::Expr, found Challenge
        }
    }

    pub fn run() {
        let air = RecursiveVerifierAir {
            opened_value: Challenge::default(),
        };
        let _trace: RowMajorMatrix<BabyBear> = RowMajorMatrix::new(vec![BabyBear::default()], 1);
        let _ = <RecursiveVerifierAir as BaseAir<BabyBear>>::width(&air);
    }
}
