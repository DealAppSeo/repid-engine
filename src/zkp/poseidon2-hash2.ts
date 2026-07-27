/**
 * Poseidon2-BabyBear 2-to-1 SCALAR hash — `H_p2(a, b)` (backlog 4.0-d.2).
 *
 * The zkp-vault ownership circuit (`zkp-vault/src/lib.rs` `OwnershipAir`) proves
 * `leaf = H(secret, agent_id)` is a member of a public commitment set and
 * `nullifier = H(secret, context)` is correctly derived (Semaphore-style; see
 * ZKP_ARCHITECTURE_INVARIANTS Invariant 2 — one identity, scoped nullifiers). That
 * hash is a **2-scalar -> 1-field** function; today it is MiMC in-AIR, and backlog
 * 4.0-d swaps it to Poseidon2. This module is the OFF-CIRCUIT half of that swap: the
 * canonical Poseidon2 2-scalar hash the circuit must reproduce bit-for-bit.
 *
 * ## Canonical definition (D-4d-1, Beat 19 de-risk spec)
 *   H_p2(a, b) := Perm16([a, b, 0, 0, ..., 0])[0]
 * Absorb the two scalars in lanes 0 and 1 of a zero-padded width-16 state, apply the
 * raw permutation (`poseidon2-babybear.ts`, 4.0-b — bit-exact vs the audited
 * `default_babybear_poseidon2_16()`), and take output lane 0. This reuses the EXACT
 * permutation already parity-gated against the Rust oracle, so it adds no new
 * permutation surface — only a fixed input/output convention.
 *
 * ## Trustworthiness (not self-referential)
 * Gated against the independent Rust oracle `zkp-vault/kat/poseidon2_babybear16_2to1_kat.json`
 * (backlog 4.0-d.1), produced by Plonky3's own `default_babybear_poseidon2_16()`. Because
 * the underlying TS permutation already reproduces p3's permutation element-for-element
 * (#196, gated on #195's raw KAT), matching this 2-to-1 KAT is genuine cross-language
 * parity — see `tests/poseidon2-hash2.test.ts`.
 *
 * ## NOT the Merkle leaf
 * `poseidon2-leaf.ts` (4.0-c) is the width-16 sponge/compression over 8-element Merkle
 * digests. THIS is the 2-scalar commitment/nullifier hash for the ownership circuit —
 * a different arity, different construction, different vertical. Not wired into any
 * production path; the in-AIR counterpart (4.0-d.3) is a separate circuit-rewrite beat.
 */

import { BABYBEAR_P, POSEIDON2_WIDTH, poseidon2Permute16 } from './poseidon2-babybear';

const P = BABYBEAR_P;

/**
 * H_p2(a, b) = Perm16([a, b, 0..])[0] over the BabyBear field.
 * Inputs are reduced into [0, p); output is a canonical field element in [0, p).
 */
export function poseidon2Hash2(a: bigint, b: bigint): bigint {
  const state = new Array<bigint>(POSEIDON2_WIDTH).fill(0n);
  state[0] = a;
  state[1] = b;
  return poseidon2Permute16(state)[0]!;
}

/**
 * Convenience wrapper over canonical u32 inputs → canonical u32 output. Mirrors the
 * Rust oracle harness, so outputs match `kat/poseidon2_babybear16_2to1_kat.json`
 * directly. Rejects non-canonical inputs (>= p, negative, non-integer).
 */
export function poseidon2Hash2u32(a: number, b: number): number {
  for (const v of [a, b]) {
    if (!Number.isInteger(v) || v < 0 || BigInt(v) >= P) {
      throw new Error(`[poseidon2-hash2] input ${v} is not a canonical BabyBear value in [0, ${P})`);
    }
  }
  return Number(poseidon2Hash2(BigInt(a), BigInt(b)));
}
