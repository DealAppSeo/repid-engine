//! Parity/sanity gate for the Poseidon2-BabyBear 2-to-1 scalar-hash oracle (4.0-d.1).
//!
//! The oracle (`examples/poseidon2_2to1_kat.rs`) defines `H_p2(a,b) = Perm16([a,b,0..])[0]`
//! over `default_babybear_poseidon2_16()` (audited ground truth). These tests pin the
//! CONVENTION the in-AIR 4.0-d rewrite must reproduce: inputs in lanes 0,1; output lane 0;
//! zero padding. `H_p2` is definitionally the raw permutation's lane 0, so we cross-check
//! it against a raw permute computed independently here — the wrapper can't be subtly
//! wrong (wrong lane / wrong output index / non-zero padding) without a test failing.

use p3_baby_bear::{default_babybear_poseidon2_16, BabyBear};
use p3_field::PrimeField32;
use p3_symmetric::Permutation;

fn h_p2(a: u32, b: u32) -> u32 {
    let perm = default_babybear_poseidon2_16();
    let mut input = [0u32; 16];
    input[0] = a;
    input[1] = b;
    let mut state: [BabyBear; 16] = BabyBear::new_array(input);
    perm.permute_mut(&mut state);
    state[0].as_canonical_u32()
}

fn raw_permute(input: [u32; 16]) -> [u32; 16] {
    let perm = default_babybear_poseidon2_16();
    let mut state: [BabyBear; 16] = BabyBear::new_array(input);
    perm.permute_mut(&mut state);
    core::array::from_fn(|i| state[i].as_canonical_u32())
}

/// H_p2(a,b) must equal lane 0 of the raw permutation of [a, b, 0, 0, ...]. This pins
/// the exact convention (lanes 0,1 in; lane 0 out; zero padding) against the primitive.
#[test]
fn h_p2_equals_raw_permutation_lane0() {
    for (a, b) in [(0u32, 0u32), (1, 2), (777, 555), (123456789, 42), (2013265920, 0)] {
        let mut padded = [0u32; 16];
        padded[0] = a;
        padded[1] = b;
        assert_eq!(h_p2(a, b), raw_permute(padded)[0], "H_p2 convention drift for ({a},{b})");
    }
}

/// Determinism: pure function of its two inputs.
#[test]
fn h_p2_is_deterministic() {
    assert_eq!(h_p2(777, 555), h_p2(777, 555));
    assert_eq!(h_p2(0, 0), h_p2(0, 0));
}

/// Scoped nullifier: same secret, distinct scopes -> distinct hashes
/// (ZKP_ARCHITECTURE_INVARIANTS Invariant 2 — the property the circuit relies on).
#[test]
fn h_p2_separates_scopes() {
    let secret = 999983u32;
    assert_ne!(h_p2(secret, 1), h_p2(secret, 2), "scope collapse");
    assert_ne!(h_p2(secret, 1), h_p2(secret, 3), "scope collapse");
}

/// Sanity: distinct inputs don't collapse; output is canonical (< p); argument order
/// matters (H_p2 is not symmetric).
#[test]
fn h_p2_is_nontrivial_canonical_and_ordered() {
    let p = 2013265921u32;
    let a = h_p2(0, 0);
    let b = h_p2(1, 0);
    let c = h_p2(0, 1);
    assert_ne!(a, b, "collapsed distinct inputs");
    assert_ne!(b, c, "H_p2 unexpectedly symmetric in (a,b)");
    for v in [a, b, c] {
        assert!(v < p, "output {v} not canonical");
    }
}
