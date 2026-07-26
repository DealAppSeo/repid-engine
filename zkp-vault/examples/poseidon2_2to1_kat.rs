//! # Poseidon2-BabyBear 2-to-1 SCALAR hash KAT oracle (backlog 4.0-d.1)
//!
//! 4.0-a/b/c gave us the raw width-16 permutation and the Merkle *sponge/compression*
//! leaf (which operate on 8-element digests). The zkp-vault ownership circuit
//! (`src/lib.rs` `OwnershipAir`) needs a different primitive: a **2-scalar -> 1-field**
//! hash for `leaf = H(secret, agent_id)` and `nullifier = H(secret, context)`
//! (Semaphore-style membership + scoped nullifier — ZKP_ARCHITECTURE_INVARIANTS Inv 2).
//! Today that in-AIR hash is MiMC (`lib.rs:50-51` itself says "production should use
//! Poseidon2"); backlog 4.0-d swaps it. The make-or-break for 4.0-d is a CANONICAL
//! definition of the 2-scalar hash that is bit-identical off-circuit (TS + Rust) AND
//! in-AIR, or a proof won't validate against an off-circuit-computed commitment set.
//!
//! ## The canonical definition (D-4d-1)
//! ```text
//! H_p2(a, b) := Perm16([a, b, 0, 0, ..., 0])[0]
//! ```
//! Absorb the two scalars in lanes 0 and 1 of a zero-padded width-16 state, apply the
//! audited `default_babybear_poseidon2_16()` permutation, output lane 0. This is the
//! standard fixed-length Poseidon2 hash of a 2-element (zero-padded) input — the
//! simplest construction that REUSES the exact permutation 4.0-b already froze against
//! this oracle's sibling (#195), so it adds no new permutation surface, only a fixed
//! input/output convention. The nullifier uses the SAME H_p2 with the scope in lane 1.
//!
//! ## Why this oracle is trustworthy, not self-referential
//! The ground truth is Plonky3's own audited `default_babybear_poseidon2_16()` (the
//! Horizen-Labs published constants). The from-scratch TS port (`poseidon2-babybear.ts`,
//! #196) reproduces that permutation element-for-element (proven against #195's raw
//! KAT). So the TS `poseidon2Hash2` matching THIS oracle is genuine cross-language
//! parity, not "both wrong the same way". What this KAT pins that the raw-permutation
//! KAT does not: the exact 2-to-1 CONVENTION (which lanes carry the inputs, which lane
//! is the output, zero-padding) — the thing the in-AIR 4.0-d rewrite must reproduce.
//!
//! ## Run (regenerate the committed KAT)
//! ```text
//! cargo run --example poseidon2_2to1_kat --manifest-path zkp-vault/Cargo.toml > zkp-vault/kat/poseidon2_babybear16_2to1_kat.json
//! ```
//! Deterministic and machine-independent (no rng; fixed published constants).
//! No Cargo.toml change: `p3-baby-bear` + `p3-symmetric` are already base deps.

use p3_baby_bear::{default_babybear_poseidon2_16, BabyBear};
use p3_field::PrimeField32;
use p3_symmetric::Permutation;

/// H_p2(a, b) = Perm16([a, b, 0..])[0] over canonical u32 field elements.
fn h_p2(a: u32, b: u32) -> u32 {
    let perm = default_babybear_poseidon2_16();
    let mut input = [0u32; 16];
    input[0] = a;
    input[1] = b;
    let mut state: [BabyBear; 16] = BabyBear::new_array(input);
    perm.permute_mut(&mut state);
    state[0].as_canonical_u32()
}

// Fixed (a, b) inputs. Chosen to cover: zeros; small iota; the leaf-shaped (777,555)
// pair the other KATs reuse; a shared-secret pair sharing lane 0 (membership-style);
// two scope pairs sharing the SAME secret in lane 0 (nullifier scope-separation:
// H_p2(s, c1) must differ from H_p2(s, c2)); and near-p canonical extremes.
const P_MINUS_1: u32 = 2013265920; // BabyBear p - 1, the max canonical value.
const INPUTS: [(&str, u32, u32); 8] = [
    ("zeros", 0, 0),
    ("one_two", 1, 2),
    ("leaf_777_555", 777, 555),
    ("secret_agent", 123456789, 42),
    ("scope_secret_ctx1", 999983, 1),
    ("scope_secret_ctx2", 999983, 2),
    ("max_max", P_MINUS_1, P_MINUS_1),
    ("max_zero", P_MINUS_1, 0),
];

fn main() {
    // Determinism self-check (pure function of input).
    for (_n, a, b) in INPUTS.iter() {
        assert_eq!(h_p2(*a, *b), h_p2(*a, *b), "h_p2 not deterministic");
    }
    // Scope-separation self-check (same secret, different scope -> different hash).
    assert_ne!(
        h_p2(999983, 1),
        h_p2(999983, 2),
        "scoped nullifier collapsed distinct scopes"
    );

    println!("{{");
    println!("  \"scheme\": \"poseidon2_babybear16_2to1\",");
    println!("  \"source\": \"p3-baby-bear 0.3.0 default_babybear_poseidon2_16 (Horizen-Labs constants), H_p2(a,b) = permute([a,b,0..])[0]\",");
    println!("  \"field_prime\": 2013265921,");
    println!("  \"width\": 16,");
    println!("  \"note\": \"2-scalar -> 1-field hash for the ownership circuit leaf/nullifier; inputs in lanes 0,1; output lane 0\",");
    println!("  \"vectors\": [");
    let n = INPUTS.len();
    for (idx, (name, a, b)) in INPUTS.iter().enumerate() {
        let output = h_p2(*a, *b);
        let comma = if idx + 1 < n { "," } else { "" };
        println!("    {{");
        println!("      \"name\": \"{}\",", name);
        println!("      \"a\": {},", a);
        println!("      \"b\": {},", b);
        println!("      \"output\": {}", output);
        println!("    }}{}", comma);
    }
    println!("  ]");
    println!("}}");
}
