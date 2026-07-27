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
use p3_field::{PrimeCharacteristicRing, PrimeField32};
use p3_symmetric::Permutation;

/// `H_p2(a, b) = Perm16([a, b, 0..])[0]` over field elements — the ONE definition.
///
/// `h_p2` (the u32 form the KAT oracle commits) and the in-AIR witness generation
/// (backlog 4.0-d.3, `OwnershipAir`) both route through this function, so the
/// off-circuit hash has exactly one definition in the crate.
pub fn h_p2_field(a: BabyBear, b: BabyBear) -> BabyBear {
    let perm = default_babybear_poseidon2_16();
    let mut state = [BabyBear::ZERO; 16];
    state[0] = a;
    state[1] = b;
    perm.permute_mut(&mut state);
    state[0]
}

/// `H_p2(a, b) = Perm16([a, b, 0..])[0]` over canonical u32 field elements.
///
/// Inputs are canonical BabyBear values (`< p = 2013265921`); values at or above `p`
/// are reduced by `BabyBear::new_array`, so callers that need rejection must check first.
pub fn h_p2(a: u32, b: u32) -> u32 {
    let reduced: [BabyBear; 2] = BabyBear::new_array([a, b]);
    h_p2_field(reduced[0], reduced[1]).as_canonical_u32()
}
