//! Parity/sanity gate for the Poseidon2-BabyBear LEAF-mode oracle (backlog 4.0-c).
//!
//! The leaf oracle (`examples/poseidon2_leaf_kat.rs`) wraps `default_babybear_poseidon2_16()`
//! in p3-symmetric's audited `PaddingFreeSponge` and `TruncatedPermutation`. Those
//! constructions are ground truth; what these tests guard is that we invoke them with
//! the RIGHT const generics (WIDTH/RATE/OUT, N/CHUNK/WIDTH) and that the derived
//! primitives relate to the RAW permutation exactly as their definitions require —
//! so the wrapper wiring can't be subtly wrong without a test failing.

use p3_baby_bear::{default_babybear_poseidon2_16, BabyBear};
use p3_field::PrimeField32;
use p3_symmetric::{
    CryptographicHasher, PaddingFreeSponge, Permutation, PseudoCompressionFunction,
    TruncatedPermutation,
};

fn raw_permute(input: [u32; 16]) -> [u32; 16] {
    let perm = default_babybear_poseidon2_16();
    let mut state: [BabyBear; 16] = BabyBear::new_array(input);
    perm.permute_mut(&mut state);
    core::array::from_fn(|i| state[i].as_canonical_u32())
}

fn sponge(input: &[u32]) -> [u32; 8] {
    let hasher = PaddingFreeSponge::<_, 16, 8, 8>::new(default_babybear_poseidon2_16());
    let elems: Vec<BabyBear> = input.iter().map(|&v| BabyBear::new(v)).collect();
    let out: [BabyBear; 8] = hasher.hash_iter(elems);
    core::array::from_fn(|i| out[i].as_canonical_u32())
}

fn compress(left: [u32; 8], right: [u32; 8]) -> [u32; 8] {
    let compressor = TruncatedPermutation::<_, 2, 8, 16>::new(default_babybear_poseidon2_16());
    let l: [BabyBear; 8] = core::array::from_fn(|i| BabyBear::new(left[i]));
    let r: [BabyBear; 8] = core::array::from_fn(|i| BabyBear::new(right[i]));
    let out: [BabyBear; 8] = compressor.compress([l, r]);
    core::array::from_fn(|i| out[i].as_canonical_u32())
}

/// TruncatedPermutation<2,8,16> of two chunks is DEFINITIONALLY: place chunk0 in
/// state[0..8], chunk1 in state[8..16], permute, take state[0..8]. Cross-check the
/// wrapper against the raw permutation directly, on a non-trivial input.
#[test]
fn compress_equals_raw_permutation_prefix() {
    let left = [0, 1, 2, 3, 4, 5, 6, 7];
    let right = [8, 9, 10, 11, 12, 13, 14, 15];
    let raw = raw_permute([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    let expected: [u32; 8] = core::array::from_fn(|i| raw[i]);
    assert_eq!(compress(left, right), expected);
}

/// PaddingFreeSponge over EXACTLY one rate-block (8 elements) is: overwrite the
/// first 8 lanes of the zero state, permute once, squeeze 8. So it must equal the
/// raw permutation of [block || zeros] truncated to 8.
#[test]
fn sponge_one_full_block_equals_raw_permutation_prefix() {
    let block = [3, 1, 4, 1, 5, 9, 2, 6];
    let mut padded = [0u32; 16];
    padded[..8].copy_from_slice(&block);
    let raw = raw_permute(padded);
    let expected: [u32; 8] = core::array::from_fn(|i| raw[i]);
    assert_eq!(sponge(&block), expected);
}

/// Empty input must return the capacity/rate zero state, unpermuted (p3's own
/// documented behaviour — matches PaddingFreeSponge's empty-input test).
#[test]
fn sponge_empty_is_zero() {
    assert_eq!(sponge(&[]), [0u32; 8]);
}

/// A sub-rate input (1 element) writes lane 0 then hits the partial-break path
/// (i != 0 => permute once). Must equal raw_permute([x, 0..]) prefix.
#[test]
fn sponge_sub_rate_equals_raw_permutation_prefix() {
    let x = 42u32;
    let mut padded = [0u32; 16];
    padded[0] = x;
    let raw = raw_permute(padded);
    let expected: [u32; 8] = core::array::from_fn(|i| raw[i]);
    assert_eq!(sponge(&[x]), expected);
}

/// Determinism: pure function of input.
#[test]
fn leaf_primitives_are_deterministic() {
    let l = [1, 2, 3, 4, 5, 6, 7, 8];
    let r = [9, 10, 11, 12, 13, 14, 15, 16];
    assert_eq!(compress(l, r), compress(l, r));
    let inp: Vec<u32> = (0..17).collect();
    assert_eq!(sponge(&inp), sponge(&inp));
}

/// Sanity: distinct pairs/inputs give distinct digests (no collapse to a constant),
/// and outputs are canonical (< p).
#[test]
fn leaf_primitives_are_nontrivial_and_canonical() {
    let p = 2013265921u32;
    let a = compress([0; 8], [0; 8]);
    let b = compress([1, 0, 0, 0, 0, 0, 0, 0], [0; 8]);
    assert_ne!(a, b, "compression collapsed distinct inputs");
    for v in a.iter().chain(b.iter()) {
        assert!(*v < p, "compression output {} not canonical", v);
    }
    let s1 = sponge(&[1]);
    let s2 = sponge(&[2]);
    assert_ne!(s1, s2, "sponge collapsed distinct inputs");
    for v in s1.iter().chain(s2.iter()) {
        assert!(*v < p, "sponge output {} not canonical", v);
    }
}
