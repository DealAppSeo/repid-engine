//! # Poseidon2-BabyBear LEAF-mode KAT oracle (backlog 4.0-c)
//!
//! The raw permutation oracle (4.0-a, PR #195) froze `Poseidon2BabyBear<16>`'s
//! bare permutation. A Merkle tree needs two *derived* primitives on top of it:
//!
//!   - a **leaf hash** (arbitrary field-element sequence -> fixed 8-element digest), and
//!   - a **2-to-1 compression** (two 8-element digests -> one 8-element digest).
//!
//! This example emits the canonical outputs of Plonky3's own audited constructions
//! for both, as JSON, so the from-scratch TypeScript leaf module (4.0-c) can be
//! gated element-for-element against an independent Rust ground truth (NOT against
//! itself — rule 3 / ZKP_ARCHITECTURE_INVARIANTS Invariant 1: leaves must be
//! aggregation-ready, i.e. bit-identical to what the Plonky3 side computes).
//!
//! ## The two canonical constructions (p3-symmetric 0.3.0)
//! - **Leaf / sponge:** `PaddingFreeSponge<Poseidon2BabyBear<16>, 16, 8, 8>`
//!   — overwrite-mode, rate 8, capacity 8, squeeze 8. This is the exact hasher
//!   Plonky3's BabyBear FRI/Merkle configs use for leaves.
//! - **Compression / pair:** `TruncatedPermutation<Poseidon2BabyBear<16>, 2, 8, 16>`
//!   — concat two 8-chunks into the 16-wide state, permute, take the first 8.
//!   This is the exact 2-to-1 compressor those configs use for internal nodes.
//!
//! Both wrap `default_babybear_poseidon2_16()` (Horizen-Labs published constants),
//! the same permutation the 4.0-a raw oracle and the 4.0-b TS port already agree on.
//! So the ONLY new surface this oracle validates is the *wrapper logic* (the sponge
//! overwrite/permute/break loop and the concat+truncate indices) — precisely the
//! part a second implementation is likely to get subtly wrong.
//!
//! ## Run (regenerate the committed KAT)
//! ```text
//! cargo run --example poseidon2_leaf_kat --manifest-path zkp-vault/Cargo.toml > zkp-vault/kat/poseidon2_babybear16_leaf_kat.json
//! ```
//! Deterministic and machine-independent (no rng; fixed published constants).
//! No Cargo.toml change: `p3-symmetric` is already a base dependency.

use p3_baby_bear::{default_babybear_poseidon2_16, BabyBear};
use p3_field::PrimeField32;
use p3_symmetric::{
    CryptographicHasher, PaddingFreeSponge, PseudoCompressionFunction, TruncatedPermutation,
};

fn bb(v: u32) -> BabyBear {
    BabyBear::new(v)
}

fn to_bb8(a: [u32; 8]) -> [BabyBear; 8] {
    core::array::from_fn(|i| bb(a[i]))
}

fn out_u32(a: [BabyBear; 8]) -> [u32; 8] {
    core::array::from_fn(|i| a[i].as_canonical_u32())
}

fn sponge(input: &[u32]) -> [u32; 8] {
    let hasher = PaddingFreeSponge::<_, 16, 8, 8>::new(default_babybear_poseidon2_16());
    let elems: Vec<BabyBear> = input.iter().map(|&v| bb(v)).collect();
    out_u32(hasher.hash_iter(elems))
}

fn compress(left: [u32; 8], right: [u32; 8]) -> [u32; 8] {
    let compressor = TruncatedPermutation::<_, 2, 8, 16>::new(default_babybear_poseidon2_16());
    out_u32(compressor.compress([to_bb8(left), to_bb8(right)]))
}

fn fmt_u32(a: &[u32]) -> String {
    let items: Vec<String> = a.iter().map(|v| v.to_string()).collect();
    format!("[{}]", items.join(", "))
}

// --- Compression KAT inputs: pairs of 8-element digests. ---
const COMPRESS_INPUTS: [(&str, [u32; 8], [u32; 8]); 3] = [
    ("zeros", [0; 8], [0; 8]),
    (
        "iota",
        [0, 1, 2, 3, 4, 5, 6, 7],
        [8, 9, 10, 11, 12, 13, 14, 15],
    ),
    (
        "leaf_pair",
        [777, 555, 0, 0, 0, 0, 0, 0],
        [111, 222, 0, 0, 0, 0, 0, 0],
    ),
];

// --- Sponge KAT inputs: variable-length field-element sequences chosen to
//     exercise every branch of the overwrite/permute/break loop:
//     empty; sub-rate (1); exact one block (8); one block + 1 (9); two exact
//     blocks (16); two blocks + 1 (17); and a byte-shaped sequence. ---
fn sponge_inputs() -> Vec<(&'static str, Vec<u32>)> {
    vec![
        ("empty", vec![]),
        ("len1", vec![42]),
        ("len8", (0..8).collect()),
        ("len9", (0..9).collect()),
        ("len16", (0..16).collect()),
        ("len17", (0..17).collect()),
        // "repid" as UTF-8 bytes promoted to field elements — mirrors the merkle
        // leaf(commitment) convention (byte -> element) the TS side documents.
        ("bytes_repid", vec![114, 101, 112, 105, 100]),
    ]
}

fn main() {
    // Determinism self-check (pure function of input).
    for (_n, l, r) in COMPRESS_INPUTS.iter() {
        assert_eq!(compress(*l, *r), compress(*l, *r), "compress not deterministic");
    }
    for (_n, inp) in sponge_inputs().iter() {
        assert_eq!(sponge(inp), sponge(inp), "sponge not deterministic");
    }

    println!("{{");
    println!("  \"scheme\": \"poseidon2_babybear16_leaf\",");
    println!("  \"source\": \"p3-symmetric 0.3.0 PaddingFreeSponge<16,8,8> + TruncatedPermutation<2,8,16> over p3-baby-bear 0.3.0 default_babybear_poseidon2_16 (Horizen-Labs constants)\",");
    println!("  \"field_prime\": 2013265921,");
    println!("  \"width\": 16,");
    println!("  \"rate\": 8,");
    println!("  \"out\": 8,");
    println!("  \"note\": \"leaf = PaddingFreeSponge overwrite-mode; pair = TruncatedPermutation (concat two 8-chunks, permute, take first 8)\",");

    // Compression vectors.
    println!("  \"compression\": [");
    let cn = COMPRESS_INPUTS.len();
    for (idx, (name, left, right)) in COMPRESS_INPUTS.iter().enumerate() {
        let output = compress(*left, *right);
        let comma = if idx + 1 < cn { "," } else { "" };
        println!("    {{");
        println!("      \"name\": \"{}\",", name);
        println!("      \"left\": {},", fmt_u32(left));
        println!("      \"right\": {},", fmt_u32(right));
        println!("      \"output\": {}", fmt_u32(&output));
        println!("    }}{}", comma);
    }
    println!("  ],");

    // Sponge vectors.
    println!("  \"sponge\": [");
    let inputs = sponge_inputs();
    let sn = inputs.len();
    for (idx, (name, input)) in inputs.iter().enumerate() {
        let output = sponge(input);
        let comma = if idx + 1 < sn { "," } else { "" };
        println!("    {{");
        println!("      \"name\": \"{}\",", name);
        println!("      \"input\": {},", fmt_u32(input));
        println!("      \"output\": {}", fmt_u32(&output));
        println!("    }}{}", comma);
    }
    println!("  ]");
    println!("}}");
}
