/**
 * Poseidon2 over the BabyBear field — from-scratch TypeScript port (backlog 4.0-b).
 *
 * This is the TS side of the ZKP_ARCHITECTURE_INVARIANTS Invariant-1 migration
 * (one hash/field: Poseidon2 over a Plonky3-native field). It reproduces, element
 * for element, the RAW 16-wide permutation of Plonky3's audited
 * `p3_baby_bear::default_babybear_poseidon2_16()` (Horizen-Labs published
 * constants). Correctness is GATED against the independent Rust KAT oracle
 * shipped in `zkp-vault/kat/poseidon2_babybear16_kat.json` (backlog 4.0-a, PR
 * #195) — see `tests/poseidon2-babybear.test.ts`.
 *
 * ## Why this is trustworthy, not self-referential
 * The oracle vectors this port validates against are produced by p3's own audited
 * implementation, and PR #195's `published_rng_vector_reproduces` test proves that
 * harness calls p3 correctly (it reproduces p3-poseidon2 0.3.0's OWN published
 * width-16 test vector). So matching the oracle is genuine cross-language parity,
 * not "both wrong the same way".
 *
 * ## Provenance of every constant / structural choice (audited p3 0.3.0)
 * - Field p = 2^31 - 2^27 + 1 = 2013265921 (`p3-baby-bear` BabyBear).
 * - S-box x^7 (`BABYBEAR_S_BOX_DEGREE = 7`; p-1 = 15·2^27 rules out 3 and 5).
 * - Width 16, external (full) rounds 8 (4 initial + 4 terminal), internal
 *   (partial) rounds 13.
 * - External round constants: `BABYBEAR_RC16_EXTERNAL_INITIAL/FINAL` — copied
 *   verbatim (hex) from `p3-baby-bear-0.3.0/src/poseidon2.rs:115-162`.
 * - Internal round constants: `BABYBEAR_RC16_INTERNAL` — verbatim from `:167-170`.
 * - Internal diagonal V (matrix 1 + Diag(V)): the exact expressions from
 *   `INTERNAL_DIAG_MONTY_16` (`:64-81`), ported not hand-computed.
 * - External linear layer = `MDSMat4` `[[2,3,1,1],[1,2,3,1],[1,1,2,3],[3,1,1,2]]`
 *   applied per 4-block + outer circulant sums (`p3-poseidon2-0.3.0` `external.rs`
 *   `apply_mat4` + `mds_light_permutation`; monty-31 scalar layer uses `&MDSMat4`,
 *   NOT `HLMDSMat4` — confirmed `p3-monty-31-0.3.0/src/poseidon2.rs:108,118`).
 * - Permutation order: initial MDS-light once, then 4 external rounds; 13 internal
 *   rounds; 4 terminal external rounds (`p3-poseidon2-0.3.0/src/lib.rs:108-112`
 *   + `external.rs` `external_initial_permute_state`/`external_terminal_permute_state`).
 *
 * NOTE (leaf construction, 4.0-c): this module is the RAW 16-element permutation.
 * The vault leaf H(a,b) = commitment/nullifier is a sponge/compression OVER this
 * permutation; the leaf-mode padding/rate design is a 4.0-c decision (and the wiring
 * into `merkle-root.ts`'s `poseidon2Scheme` placeholder). Nailing the raw permutation
 * first is the atomic parity primitive everything else builds on. No production
 * behaviour changes by adding this module — it is not yet wired anywhere.
 *
 * All field arithmetic uses BigInt (products of two <p values reach ~2^62, beyond
 * Number.MAX_SAFE_INTEGER) — correctness first; the permutation is tiny.
 */

/** BabyBear prime: 2^31 - 2^27 + 1. */
export const BABYBEAR_P = 2013265921n;

export const POSEIDON2_WIDTH = 16;
export const POSEIDON2_SBOX_DEGREE = 7;
export const POSEIDON2_EXTERNAL_ROUNDS = 8; // 4 initial + 4 terminal
export const POSEIDON2_INTERNAL_ROUNDS = 13;

// --- Field ops (canonical representatives in [0, p)) ---

const P = BABYBEAR_P;

/** Reduce a possibly-large / possibly-negative bigint into [0, p). */
function fmod(x: bigint): bigint {
  const r = x % P;
  return r < 0n ? r + P : r;
}

function fadd(a: bigint, b: bigint): bigint {
  const s = a + b;
  return s >= P ? s - P : s;
}

function fsub(a: bigint, b: bigint): bigint {
  const d = a - b;
  return d < 0n ? d + P : d;
}

function fmul(a: bigint, b: bigint): bigint {
  return (a * b) % P;
}

/** S-box: x^7 mod p. */
function sbox(x: bigint): bigint {
  const x2 = fmul(x, x);
  const x4 = fmul(x2, x2);
  const x6 = fmul(x4, x2);
  return fmul(x6, x);
}

// --- Round constants (verbatim hex from p3-baby-bear 0.3.0 src/poseidon2.rs) ---

/** BABYBEAR_RC16_EXTERNAL_INITIAL — 4 rounds x 16 (src/poseidon2.rs:115-136). */
const RC16_EXTERNAL_INITIAL: readonly bigint[][] = [
  [
    0x69cbb6afn, 0x46ad93f9n, 0x60a00f4en, 0x6b1297cdn, 0x23189afen, 0x732e7befn, 0x72c246den,
    0x2c941900n, 0x0557eeden, 0x1580496fn, 0x3a3ea77bn, 0x54f3f271n, 0x0f49b029n, 0x47872fe1n,
    0x221e2e36n, 0x1ab7202en,
  ],
  [
    0x487779a6n, 0x3851c9d8n, 0x38dc17c0n, 0x209f8849n, 0x268dcee8n, 0x350c48dan, 0x5b9ad32en,
    0x0523272bn, 0x3f89055bn, 0x01e894b2n, 0x13ddedden, 0x1b2ef334n, 0x7507d8b4n, 0x6ceeb94en,
    0x52eb6ba2n, 0x50642905n,
  ],
  [
    0x05453f3fn, 0x06349efcn, 0x6922787cn, 0x04bfff9cn, 0x768c714an, 0x3e9ff21an, 0x15737c9cn,
    0x2229c807n, 0x0d47f88cn, 0x097e0eccn, 0x27eadba0n, 0x2d7d29e4n, 0x3502aaa0n, 0x0f475fd7n,
    0x29fbda49n, 0x018afffdn,
  ],
  [
    0x0315b618n, 0x6d4497d1n, 0x1b171d9en, 0x52861abdn, 0x2e5d0501n, 0x3ec8646cn, 0x6e5f250an,
    0x148ae8e6n, 0x17f5fa4an, 0x3e66d284n, 0x0051aa3bn, 0x483f7913n, 0x2cfe5f15n, 0x023427can,
    0x2cc78315n, 0x1e36ea47n,
  ],
];

/** BABYBEAR_RC16_EXTERNAL_FINAL — 4 rounds x 16 (src/poseidon2.rs:141-162). */
const RC16_EXTERNAL_FINAL: readonly bigint[][] = [
  [
    0x7290a80dn, 0x6f7e5329n, 0x598ec8a8n, 0x76a859a0n, 0x6559e868n, 0x657b83afn, 0x13271d3fn,
    0x1f876063n, 0x0aeeae37n, 0x706e9ca6n, 0x46400ceen, 0x72a05c26n, 0x2c589c9en, 0x20bd37a7n,
    0x6a2d3d10n, 0x20523767n,
  ],
  [
    0x5b8fe9c4n, 0x2aa501d6n, 0x1e01ac3en, 0x1448bc54n, 0x5ce5ad1cn, 0x4918a14dn, 0x2c46a83fn,
    0x4fcf6876n, 0x61d8d5c8n, 0x6ddf4ff9n, 0x11fda4d3n, 0x02933a8fn, 0x170eaf81n, 0x5a9c314fn,
    0x49a12590n, 0x35ec52a1n,
  ],
  [
    0x58eb1611n, 0x5e481e65n, 0x367125c9n, 0x0eba33ban, 0x1fc28dedn, 0x066399adn, 0x0cbec0ean,
    0x75fd1af0n, 0x50f5bf4en, 0x643d5f41n, 0x6f4fe718n, 0x5b3cbbden, 0x1e3afb3en, 0x296fb027n,
    0x45e1547bn, 0x4a8db2abn,
  ],
  [
    0x59986d19n, 0x30bcdfa3n, 0x1db63932n, 0x1d7c2824n, 0x53b33681n, 0x0673b747n, 0x038a98a3n,
    0x2c5bce60n, 0x351979cdn, 0x5008fb73n, 0x547bca78n, 0x711af481n, 0x3f93bf64n, 0x644d987bn,
    0x3c8bcd87n, 0x608758b8n,
  ],
];

/** BABYBEAR_RC16_INTERNAL — 13 (src/poseidon2.rs:167-170). */
const RC16_INTERNAL: readonly bigint[] = [
  0x5a8053c0n, 0x693be639n, 0x3858867dn, 0x19334f6bn, 0x128f0fd8n, 0x4e2b1ccbn, 0x61210ce0n,
  0x3c318939n, 0x0b5b2f22n, 0x2edb11d5n, 0x213effdfn, 0x0cac4606n, 0x241af16dn,
];

/**
 * Internal diagonal V for BabyBear16, matrix (1 + Diag(V)).
 * Ported EXACTLY from `INTERNAL_DIAG_MONTY_16` (src/poseidon2.rs:64-81):
 * [-2, 1, 2, 1/2, 3, 4, -1/2, -3, -4, 1/2^8, 1/4, 1/8, 1/2^27, -1/2^8, -1/16, -1/2^27]
 * using: -1/2^n = (p-1) >> n ; 1/2^n = p - ((p-1) >> n) ; 1/2 = (p+1) >> 1.
 */
export const INTERNAL_DIAG_16: readonly bigint[] = [
  P - 2n,
  1n,
  2n,
  (P + 1n) >> 1n,
  3n,
  4n,
  (P - 1n) >> 1n,
  P - 3n,
  P - 4n,
  P - ((P - 1n) >> 8n),
  P - ((P - 1n) >> 2n),
  P - ((P - 1n) >> 3n),
  P - 15n,
  (P - 1n) >> 8n,
  (P - 1n) >> 4n,
  15n,
];

// --- Linear layers ---

/**
 * MDSMat4: multiply a 4-element block by [[2,3,1,1],[1,2,3,1],[1,1,2,3],[3,1,1,2]].
 * Direct port of `apply_mat4` (p3-poseidon2-0.3.0 external.rs:60-74) — the matrix
 * used by the BabyBear (monty-31) external layer.
 */
function applyMat4(x: bigint[], off: number): void {
  const x0 = x[off]!;
  const x1 = x[off + 1]!;
  const x2 = x[off + 2]!;
  const x3 = x[off + 3]!;
  const t01 = fadd(x0, x1);
  const t23 = fadd(x2, x3);
  const t0123 = fadd(t01, t23);
  const t01123 = fadd(t0123, x1);
  const t01233 = fadd(t0123, x3);
  // x3 = 3*x0 + x1 + x2 + 2*x3
  x[off + 3] = fadd(t01233, fadd(x0, x0));
  // x1 = x0 + 2*x1 + 3*x2 + x3
  x[off + 1] = fadd(t01123, fadd(x2, x2));
  // x0 = 2*x0 + 3*x1 + x2 + x3
  x[off] = fadd(t01123, t01);
  // x2 = x0 + x1 + 2*x2 + 3*x3
  x[off + 2] = fadd(t01233, t23);
}

/**
 * External linear layer for WIDTH=16: apply MDSMat4 to each 4-block, then add the
 * outer circulant sums (state[i] += sum over blocks of element at position i%4).
 * Port of `mds_light_permutation` WIDTH=16 branch (external.rs:135-157).
 */
function externalLinearLayer(state: bigint[]): void {
  for (let off = 0; off < POSEIDON2_WIDTH; off += 4) {
    applyMat4(state, off);
  }
  // sums[k] = state[0+k] + state[4+k] + state[8+k] + state[12+k]
  const sums: bigint[] = [0n, 0n, 0n, 0n];
  for (let k = 0; k < 4; k++) {
    let s = 0n;
    for (let j = 0; j < POSEIDON2_WIDTH; j += 4) {
      s = fadd(s, state[j + k]!);
    }
    sums[k] = s;
  }
  for (let i = 0; i < POSEIDON2_WIDTH; i++) {
    state[i] = fadd(state[i]!, sums[i % 4]!);
  }
}

/**
 * Internal linear layer: sum = Σ state; state[i] = sum + V[i]*state[i].
 * This is (1 + Diag(V)) · state (`matmul_internal`, p3-poseidon2 internal.rs:47-56;
 * equivalent to BabyBear's `internal_layer_mat_mul`, verified by p3's own
 * `test_generic_internal_linear_layer_16`).
 */
function internalLinearLayer(state: bigint[]): void {
  let sum = 0n;
  for (let i = 0; i < POSEIDON2_WIDTH; i++) {
    sum = fadd(sum, state[i]!);
  }
  for (let i = 0; i < POSEIDON2_WIDTH; i++) {
    state[i] = fadd(sum, fmul(INTERNAL_DIAG_16[i]!, state[i]!));
  }
}

// --- The permutation ---

/**
 * Raw Poseidon2-BabyBear width-16 permutation. Input/output are canonical field
 * elements in [0, p) as bigint. Mutates a copy; returns the new 16-element state.
 * Reproduces `default_babybear_poseidon2_16().permute_mut()` element-for-element.
 */
export function poseidon2Permute16(input: readonly bigint[]): bigint[] {
  if (input.length !== POSEIDON2_WIDTH) {
    throw new Error(`[poseidon2-babybear] expected ${POSEIDON2_WIDTH} elements, got ${input.length}`);
  }
  const state: bigint[] = input.map((v) => fmod(v));

  // 1. Initial external layer: one MDS-light, then 4 initial full rounds.
  externalLinearLayer(state);
  for (const rc of RC16_EXTERNAL_INITIAL) {
    for (let i = 0; i < POSEIDON2_WIDTH; i++) {
      state[i] = sbox(fadd(state[i]!, rc[i]!));
    }
    externalLinearLayer(state);
  }

  // 2. Internal (partial) rounds: add RC to state[0], S-box state[0], internal MDS.
  for (const rc of RC16_INTERNAL) {
    state[0] = sbox(fadd(state[0]!, rc));
    internalLinearLayer(state);
  }

  // 3. Terminal external layer: 4 final full rounds (each ends with MDS-light).
  for (const rc of RC16_EXTERNAL_FINAL) {
    for (let i = 0; i < POSEIDON2_WIDTH; i++) {
      state[i] = sbox(fadd(state[i]!, rc[i]!));
    }
    externalLinearLayer(state);
  }

  return state;
}

/**
 * Convenience wrapper: canonical u32 in → canonical u32 out. Mirrors the oracle
 * harness (`BabyBear::new_array(u32)` → `permute_mut` → `as_canonical_u32`), so
 * outputs match `kat/poseidon2_babybear16_kat.json` directly.
 */
export function poseidon2Permute16u32(input: readonly number[]): number[] {
  if (input.length !== POSEIDON2_WIDTH) {
    throw new Error(`[poseidon2-babybear] expected ${POSEIDON2_WIDTH} u32s, got ${input.length}`);
  }
  for (const v of input) {
    if (!Number.isInteger(v) || v < 0 || BigInt(v) >= P) {
      throw new Error(`[poseidon2-babybear] input ${v} is not a canonical BabyBear value in [0, ${P})`);
    }
  }
  const out = poseidon2Permute16(input.map((v) => BigInt(v)));
  return out.map((v) => Number(v));
}
