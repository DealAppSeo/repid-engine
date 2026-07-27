//! # Canonical off-circuit Poseidon2-BabyBear 2-scalar hash `H_p2` (backlog 4.0-d.1)
//!
//! ```text
//! H_p2(a, b) := Perm16([a, b, 0, 0, ..., 0])[0]
//! ```
//!
//! Absorb the two scalars in lanes 0 and 1 of a zero-padded width-16 state, apply the
//! audited `default_babybear_poseidon2_16()` permutation (Horizen-Labs published
//! constants), output lane 0. This is the 2-scalar -> 1-field hash the ownership
//! circuit needs for `leaf = H(secret, agent_id)` and `nullifier = H(secret, context)`
//! (Semaphore-style membership + scoped nullifier — ZKP_ARCHITECTURE_INVARIANTS Inv 2).
//!
//! ## Why this lives in the crate rather than in the KAT files
//! The definition is consumed by three places that MUST agree bit-for-bit:
//! the KAT generator (`examples/poseidon2_2to1_kat.rs`), its gate
//! (`tests/poseidon2_2to1_kat.rs`), and — once backlog 4.0-d.3 lands — the in-AIR
//! rewrite of `OwnershipAir`. A single definition here makes generator/gate drift
//! impossible by construction; previously each file carried its own copy, so the
//! gate validated itself rather than the generator that produced the committed KAT.
//!
//! The TypeScript counterpart is `src/zkp/poseidon2-hash2.ts` (backlog 4.0-d.2),
//! gated against the KAT this function generates.

use p3_baby_bear::{default_babybear_poseidon2_16, BabyBear};
use p3_field::PrimeField32;
use p3_symmetric::Permutation;

/// `H_p2(a, b) = Perm16([a, b, 0..])[0]` over canonical u32 field elements.
///
/// Inputs are canonical BabyBear values (`< p = 2013265921`); values at or above `p`
/// are reduced by `BabyBear::new_array`, so callers that need rejection must check first.
pub fn h_p2(a: u32, b: u32) -> u32 {
    let perm = default_babybear_poseidon2_16();
    let mut input = [0u32; 16];
    input[0] = a;
    input[1] = b;
    let mut state: [BabyBear; 16] = BabyBear::new_array(input);
    perm.permute_mut(&mut state);
    state[0].as_canonical_u32()
}
