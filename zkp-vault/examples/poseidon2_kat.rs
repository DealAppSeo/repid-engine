//! # Poseidon2-BabyBear KAT oracle generator (backlog 4.0-a)
//!
//! Emits the **canonical** `Poseidon2BabyBear<16>` permutation outputs for a set
//! of fixed input vectors, as JSON. This is the *ground-truth oracle* for the
//! from-scratch TypeScript Poseidon2 implementation (backlog 4.0-b): the TS port
//! must reproduce these outputs element-for-element, or its field arithmetic /
//! round constants / diffusion layer are wrong.
//!
//! ## Why this is a trustworthy oracle (not self-referential)
//! The permutation comes from `p3_baby_bear::default_babybear_poseidon2_16()`,
//! which is Plonky3's own audited implementation using the **published
//! Horizen-Labs round constants** for BabyBear
//! (`BABYBEAR_RC16_EXTERNAL_INITIAL/FINAL`, `BABYBEAR_RC16_INTERNAL`). These are
//! the canonical constants a TS port can transcribe. We deliberately do NOT use
//! the crate's `new_from_rng_128` constructor (rng-generated constants that a
//! second implementation could never reproduce).
//!
//! ## Instance parameters (BabyBear, width 16) — for the TS port
//! - Field: BabyBear, p = 2^31 − 2^27 + 1 = 2013265921.
//! - S-box: x^7 (degree 7; p−1 = 15·2^27 makes 3 and 5 non-permutations, 7 is minimal).
//! - Width: 16. External (full) rounds: 8 (4 initial + 4 final). Internal (partial) rounds: 13.
//! - Internal diagonal (1 + Diag(V)), BabyBear16:
//!   [-2, 1, 2, 1/2, 3, 4, -1/2, -3, -4, 1/2^8, 1/4, 1/8, 1/2^27, -1/2^8, -1/16, -1/2^27].
//! - Constants: the published Horizen-Labs BabyBear tables (see p3-baby-bear 0.3.0
//!   `src/poseidon2.rs`, `default_babybear_poseidon2_16`).
//!
//! ## Run
//! ```text
//! cargo run --example poseidon2_kat --manifest-path zkp-vault/Cargo.toml > zkp-vault/kat/poseidon2_babybear16_kat.json
//! ```
//! The output is deterministic and machine-independent (no rng, fixed constants).
//!
//! NOTE (leaf construction, 4.0-b/c): this oracle is the RAW 16-element permutation.
//! The vault leaf `H(a,b)` = commitment/nullifier is a *sponge/compression* over this
//! permutation; the leaf-mode padding/rate design is a 4.0-b/c decision. Nailing the
//! raw permutation first is the atomic parity primitive everything else builds on.

use p3_baby_bear::{default_babybear_poseidon2_16, BabyBear};
use p3_field::PrimeField32;
use p3_symmetric::Permutation;

/// Fixed KAT input vectors (canonical u32 representatives, each < BabyBear p).
/// Chosen to be simple, reproducible, and to exercise distinct structure:
///  - all-zeros (identity-of-input edge)
///  - iota 0..15 (distinct ascending elements)
///  - all-ones (uniform nonzero)
///  - leaf-shaped: [secret, agent_id, 0.., ..] mirroring the vault's H(secret, agent_id) domain
const KAT_INPUTS: [(&str, [u32; 16]); 4] = [
    ("zeros", [0; 16]),
    (
        "iota",
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    ),
    ("ones", [1; 16]),
    (
        "leaf_777_555",
        [777, 555, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ),
];

fn permute(input_u32: [u32; 16]) -> [u32; 16] {
    let perm = default_babybear_poseidon2_16();
    let mut state: [BabyBear; 16] = BabyBear::new_array(input_u32);
    perm.permute_mut(&mut state);
    let mut out = [0u32; 16];
    for (i, e) in state.iter().enumerate() {
        out[i] = e.as_canonical_u32();
    }
    out
}

fn fmt_u32_array(a: &[u32; 16]) -> String {
    let items: Vec<String> = a.iter().map(|v| v.to_string()).collect();
    format!("[{}]", items.join(", "))
}

fn main() {
    // Determinism self-check: the permutation must be a pure function of its input.
    for (_name, input) in KAT_INPUTS.iter() {
        assert_eq!(
            permute(*input),
            permute(*input),
            "Poseidon2BabyBear<16> permutation is not deterministic — oracle invalid"
        );
    }

    println!("{{");
    println!("  \"scheme\": \"poseidon2_babybear16\",");
    println!("  \"source\": \"p3-baby-bear 0.3.0 default_babybear_poseidon2_16 (Horizen-Labs published constants)\",");
    println!("  \"field_prime\": 2013265921,");
    println!("  \"width\": 16,");
    println!("  \"sbox_degree\": 7,");
    println!("  \"external_rounds\": 8,");
    println!("  \"internal_rounds\": 13,");
    println!("  \"note\": \"RAW permutation KAT — leaf sponge/compression is a 4.0-b/c design decision\",");
    println!("  \"vectors\": [");
    let n = KAT_INPUTS.len();
    for (idx, (name, input)) in KAT_INPUTS.iter().enumerate() {
        let output = permute(*input);
        let comma = if idx + 1 < n { "," } else { "" };
        println!("    {{");
        println!("      \"name\": \"{}\",", name);
        println!("      \"input\": {},", fmt_u32_array(input));
        println!("      \"output\": {}", fmt_u32_array(&output));
        println!("    }}{}", comma);
    }
    println!("  ]");
    println!("}}");
}
