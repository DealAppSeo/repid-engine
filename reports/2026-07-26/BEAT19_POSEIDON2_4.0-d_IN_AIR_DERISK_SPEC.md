# Beat 19 — Apex 4.0-d de-risk spec: swapping the in-AIR leaf hash from MiMC → Poseidon2

**Date:** 2026-07-26 · **Author:** Claude (autonomous build-loop, Beat 19) · **Type:** reference spec, read-only investigation (NO code, NO PR)
**Purpose:** turn the perpetually-deferred "larger beat" 4.0-d into fill-in-the-implementation, the same way Beat 15 de-risked 4.0 overall. Grounded in direct reads of `zkp-vault/src/lib.rs`, `zkp-vault/Cargo.{toml,lock}`, the local cargo cache, and crates.io/docs.rs for `p3-poseidon2-air` 0.3.0.

---

## TL;DR (the two findings that de-risk the beat)

1. **4.0-d is NOT a drop-in S-box swap.** The in-AIR statement (`zkp-vault/src/lib.rs`) computes its leaf and nullifier as a **scalar 2-input MiMC hash** `H(a,b) = perm(a,b) + a + b` with a hand-written per-round column layout (W = 2R+3 = 27, R = 12, degree-7). 4.0-b/c built a **width-16 Poseidon2 permutation** and a **sponge/compression** leaf for *Merkle digests* (8-element chunks). These are **different hash constructions over a different arity.** 4.0-d is a **circuit rewrite** that must (a) define a canonical *2-scalar* Poseidon2 hash and (b) re-express the AIR around a width-16 permutation.

2. **The audited AIR gadget exists at the pinned version → 4.0-d is bounded.** `p3-poseidon2-air` **0.3.0 is published on crates.io** (12 versions total; 0.3.0 confirmed) and exports `Poseidon2Air`, `Poseidon2Cols`, `RoundConstants`, `generate_trace_rows()`, `num_cols()`, `make_col_map()`. It is **NOT yet a dependency** of `zkp-vault` (only `p3-air` and transitive `p3-poseidon2` are in the lock). Adding it is one `Cargo.toml` line at the same 0.3.0 family — so 4.0-d can use the **audited** Poseidon2 constraints instead of hand-rolling 16-lane round logic (which would be trivially subtly-wrong → rules 2/4 caution). **Do NOT hand-roll the permutation constraints.**

---

## 1. What the in-AIR statement is today [V code-read `zkp-vault/src/lib.rs`]

`OwnershipAir` is a **Semaphore-style anonymous-ownership** circuit (D-019/D-020), NOT a reputation/POSTCARD circuit. It proves:
- `leaf = H(secret, agent_id)` is one of the public commitments `{C_0..C_{M-1}}` (membership via vanishing product `∏(leaf − C_j) = 0`), without revealing which;
- `nullifier = H(secret, context)` is correctly derived.

The in-AIR hash **H** (`lib.rs:38-42, 119-152, 181-216`):
- **MiMC**, S-box `x^7` (minimal permutation exponent coprime to `p−1` for BabyBear; `x^5` is not a permutation here), **R = 12** rounds, key-injected each round with `RC[r]` (`lib.rs:91-94`), **Miyaguchi–Preneel** finalize `H(a,b) = state_R + a + b`.
- Column layout **W = 2R+3 = 27** (`lib.rs:82-88`): `[secret, agent_id, L_1..L_R (12), N_1..N_R (12), leaf]`. Single logical row replicated to `HEIGHT = 8`.
- Two MiMC chains (leaf + nullifier) share the `secret` input; each is 12 degree-7 constraints. FRI `log_blowup = 3` (blowup 8) chosen precisely so the LDE covers the degree-7 quotient domain (`lib.rs:236-244`).
- Zero-knowledge = hiding FRI PCS + hiding Merkle MMCS (`HidingFriPcs` + `MerkleTreeHidingMmcs`), reused verbatim.

The code's own honest scope note (`lib.rs:50-51`): *"MiMC over BabyBear gives ~field-size security; production should use Poseidon2 over a larger field and audited round constants/counts."* **4.0-d is exactly this line.**

## 2. The make-or-break: hash-construction reconciliation

The commitment/nullifier is a **2-scalar → 1-field** hash. 4.0-b's Poseidon2 is a **width-16 permutation**; 4.0-c wrapped it as a **sponge (`PaddingFreeSponge<Perm,16,8,8>`)** and **2:1 compression (`TruncatedPermutation<Perm,2,8,16>`)** — both operate on **8-element digests** for *Merkle* hashing. Neither is the 2-scalar commitment hash.

**Decision D-4d-1 (canonical 2-scalar Poseidon2 hash).** Define
```
H_p2(a, b) := Poseidon2Perm16([a, b, 0, 0, …, 0])[0]      // absorb 2 scalars in lanes 0,1; output lane 0
```
(a fixed-length 2-to-1 hash — the standard Poseidon2 "compression of a padded input" for small arity). Rationale:
- Simplest construction that reuses the **exact** 4.0-b permutation (already parity-gated against the Rust oracle #195), so no new permutation surface.
- Matches how the AIR gadget works: `p3-poseidon2-air` constrains a **permutation**; the wrapper (load 2 inputs, read 1 output) is a handful of custom boundary constraints, not new round logic.
- **Nullifier uses the same `H_p2`** with `context` in lane 1 (`H_p2(secret, context)`), preserving today's scoping semantics (Invariant 2: `nullifier = Poseidon2(secret, scope)`).

**Hard invariant (the make-or-break):** `H_p2` must be **defined identically off-circuit (TS + Rust) and in-AIR**, or a proof will not validate against an off-circuit-computed commitment set `{C_j}`. This is the same class of trap Invariant 1 warns about. Gate it with a **new KAT**: extend #195's oracle (`zkp-vault/examples/`) to emit `H_p2(a,b)` for fixed `(a,b)` pairs, and assert the TS `poseidon2-babybear.ts` (#196) reproduces them element-for-element (a 2-scalar analogue of 4.0-c's leaf KAT). Off-circuit ground truth first, in-AIR second.

> Note: the off-circuit **POSTCARD commitment** migration (`src/zkp/commitment.ts` sha256 → Poseidon2, ZKP Invariant 1) is a **separate track (4.0-e)**, not 4.0-d. 4.0-d is the *zkp-vault ownership circuit*; 4.0-e is the *POSTCARD/EAS commitment*. They share the `poseidon2-babybear.ts` primitive but touch different files and serve different verticals. Sequencing note in §5.

## 3. Using the audited gadget (`p3-poseidon2-air` 0.3.0) [V crates.io + docs.rs]

- **Availability:** published, 0.3.0 confirmed (checksum family matches the rest of the pinned p3 0.3.0 tree; `p3-poseidon2` 0.3.0 is already transitively locked, checksum `88e9f053…`). Add `p3-poseidon2-air = "0.3.0"` to `zkp-vault/Cargo.toml` `[dependencies]`.
- **API surface (0.3.0):** `Poseidon2Air` (single-perm AIR), `Poseidon2Cols` (its column struct), `VectorizedPoseidon2Air`/`VectorizedPoseidon2Cols` (multi-perm per row), `RoundConstants`, `FullRound`/`PartialRound`/`SBox` (round components), `generate_trace_rows()`, `num_cols()`, `make_col_map()`.
- **Const generics (CONFIRM against 0.3.0 source at build — docs excerpt did not enumerate them; the p3 0.3.0 signature is `Poseidon2Air<F, LinearLayers, WIDTH, SBOX_DEGREE, SBOX_REGISTERS, HALF_FULL_ROUNDS, PARTIAL_ROUNDS>`):** target `WIDTH=16, SBOX_DEGREE=7, HALF_FULL_ROUNDS=4, PARTIAL_ROUNDS=13` to match 4.0-b's BabyBear<16> instance. `SBOX_REGISTERS` is a proving-efficiency knob (how many helper columns linearize `x^7`); pick per the crate's BabyBear examples.
- **LinearLayers type:** the gadget is generic over a `GenericPoseidon2LinearLayers`-style parameter that supplies the external `MDSMat4` + internal diagonal. This is provided by `p3-baby-bear` 0.3.0 (`GenericPoseidon2LinearLayersBabyBear` or equivalent) — the **same** linear layer 4.0-b ported (MDSMat4, NOT HLMDSMat4; confirmed in Beat 17). **Confirm the exact re-export name in the 0.3.0 `p3-baby-bear` source** (it moved between p3 versions).
- **RoundConstants:** must be the **published Horizen-Labs BabyBear constants** — the same ones `default_babybear_poseidon2_16()` uses (#195's oracle) and the TS port transcribes. Feeding the gadget a *different* constant set (e.g. an rng-derived one) would break parity with the off-circuit commitment. This is the single highest-risk integration point after D-4d-1.

## 4. Circuit-rewrite shape (what actually changes in `lib.rs`)

The current single-row hand-written MiMC AIR becomes a Poseidon2-gadget-backed AIR. Two viable layouts:

- **Layout A — two permutations, one row.** Embed two `Poseidon2Cols` blocks (leaf perm + nullifier perm) side-by-side in the trace width, plus boundary columns `[secret, agent_id, context, leaf, nullifier]` and the membership product. `eval()` = call the gadget's per-permutation constraint eval on each block + custom constraints: input lanes `(0,1)` equal `(secret, agent_id)` / `(secret, context)` and the rest zero; `leaf = leafPerm.output[0]`; `nullifier = nullPerm.output[0]`; `nullifier == null_pub` (public); `∏(leaf − C_j) = 0`. Trace built via `generate_trace_rows()` per permutation, then stitched.
- **Layout B — vectorized.** Use `VectorizedPoseidon2Air` to pack both permutations; thinner custom glue. Slightly more gadget-API surface to learn.

**Recommendation:** Layout A first (explicit, easiest to reason about + test); optimize to B only if proving cost matters.

Downstream deltas, all mechanical once the gadget is in:
- `mimc_states`/`mimc_hash`/`commitment`/`nullifier` (in-clear, `lib.rs:119-152`) → replace with `H_p2` in-clear (call the #196/#195 Rust permutation). **`commitment()` and `nullifier()` signatures stay** (`u64,u64 → Val`), so `prove_ownership`/`verify_ownership`/public-values plumbing is unchanged.
- FRI `log_blowup`: Poseidon2 external rounds are degree-7 (`x^7`), **same as MiMC's `pow7`** → **`log_blowup = 3` stays valid** (no PCS change). Confirm the gadget doesn't raise effective constraint degree above 7 (SBOX_REGISTERS exists precisely to keep it at the S-box degree).
- All **6 GATE tests must stay green** (`valid_owner_accepts`, `forged_nullifier_rejected`, `non_member_is_unprovable`, `tampered_proof_rejected`, `unlinkable_across_contexts`, `double_action_detectable_in_context`) — they are construction-agnostic (they assert behavior, not MiMC internals), so they are the built-in regression gate for the rewrite.

## 5. Build order (bounded sub-steps) + open decisions

**4.0-d proper (its own dedicated beat, cargo free, verifier not on the branch):**
1. **4.0-d.0** — add `p3-poseidon2-air = "0.3.0"`; confirm const generics + the BabyBear LinearLayers re-export name against the 0.3.0 source; `cargo build` clean.
2. **4.0-d.1** — extend #195's oracle to emit `H_p2(a,b)` KAT vectors (2-scalar hash) → new `kat/poseidon2_babybear16_2to1_kat.json`; Rust test asserts `H_p2` == `Poseidon2Perm16([a,b,0..])[0]` (definitional, non-self-referential).
3. **4.0-d.2** — TS gate: `poseidon2-babybear.ts` (#196) reproduces the `H_p2` KAT (add to its test). *This is off-circuit and can be done NOW as a small standalone addition to the #196/#197 track if desired.*
4. **4.0-d.3** — rewrite `OwnershipAir` (Layout A) using `Poseidon2Air` + custom boundary constraints; regenerate the witness with the in-clear `H_p2`; all 6 GATE tests green + a new test asserting the in-AIR `leaf`/`nullifier` equal the off-circuit `H_p2` (circuit↔off-circuit parity — the make-or-break).
5. **4.0-d.4** — re-run the benchmark; record prove/verify ms + proof size delta vs MiMC (Poseidon2 has more columns → expect larger trace; quantify, don't guess).

**Open decisions for the 4.0-d beat (flag, don't pre-decide):**
- WIDTH 16 vs 24 (16 matches 4.0-b and is sufficient for a 2-scalar hash; 24 only if a future statement needs more rate).
- `SBOX_REGISTERS` value (proving-cost vs column-count tradeoff; take the crate's BabyBear example default).
- Whether the nullifier truly needs a *second* full permutation or can share domain separation within one (keep two for clarity/soundness first).

**Sequencing vs 4.0-e and the PR queue:**
- 4.0-d is **zkp-vault (Rust) only**; 4.0-e is **`src/zkp/commitment.ts` (TS)**. Independent files, can proceed in either order.
- **10 loop PRs (#188–#197) currently await Sean; #190 is the single whole-queue unblock.** Per standing loop guidance, do **not** stack an 11th PR before the queue moves. 4.0-d wants its own branch off `main` **after** the queue starts moving (and cargo/branch free of a running verifier). Until then, the highest-value collision-free work is spec/diagnostic (this doc) or the small off-track **4.0-d.2** TS `H_p2` KAT addition if a bounded code deliverable is wanted.

## 6. Honest limits of this spec [R]
- Const generic parameter list + the exact BabyBear `LinearLayers` re-export name for `p3-poseidon2-air` 0.3.0 were **not enumerable from the docs.rs excerpt**; they must be confirmed against the vendored 0.3.0 source at build time (§3, §5.1). Everything else is [V] from disk / crates.io / the pinned lock.
- No `cargo`/`jest` was run this beat (an independent verifier held the branch checkout + `target/`); all findings are static reads. The build steps in §5 are the point at which they become executable.
