# Beat 15 — Poseidon2 Leaf (Backlog 4.0) De-Risking Spec + Canon Corrections
**Date:** 2026-07-26 · **Author:** autonomous build-loop (Claude, apex lane) · **Type:** reference artifact (NO code shipped, NO PR)
**Purpose:** Turn the perpetually-deferred apex task 4.0 ("Complete Poseidon2 leaf, ~70% built, KATs frozen") from a multi-hour research expedition into a bounded, fill-in-the-implementation task — by pinning the *actual* on-disk reality, defining the *correct* parity oracle, and laying out the build order. Grounds the eventual dedicated 4.0 beat so it does not re-discover the landscape.

**Why this instead of implementing Poseidon2 now:** implementing Poseidon2-over-BabyBear bit-exact in TS **and** Rust is genuine frontier crypto that is trivially, subtly wrong; shipping an unvalidated "Poseidon2" as green would violate loop rules 2/4 (Beats 10 & 14 correctly declined it as un-bounded). But the *research/sourcing* half — what the oracle is, where the constants live, the parity test design — **is** bounded and de-risks the hard beat. That is this artifact.

---

## 1. CANON CORRECTIONS — three "facts" refuted by direct on-disk read [V]

All three are load-bearing for anyone scoping 4.0. Each is verified against the checked-out `repid-engine` `main` (`zkp-vault/` + `src/zkp/`), not memory.

### 1.1 "Poseidon2 leaf ~70% built, golden KATs frozen (0x32ed1341 / 0x669d7ab7)" → **FALSE. There is no Poseidon2 anywhere.** [V]
The system currently uses **three different hash families, none of them Poseidon2:**

| Surface | File · line | Hash actually used | Evidence |
|---|---|---|---|
| TS commitment (POSTCARD leaf) | `src/zkp/commitment.ts:55` | **sha256** | `createHash('sha256')`; header comment (`:14-23`) flags "TODAY the live path is sha256… Poseidon2 is a Sean/XC call, not pre-empted" |
| Rust in-AIR leaf (`zkp-vault`) | `zkp-vault/src/lib.rs:139-147` | **MiMC**, S-box `x^7`, Miyaguchi–Preneel `H(a,b)=perm(a,b)+a+b`, R=12 rounds | `pow7()` (`:121`), `mimc_hash()` (`:139`); doc comment `:50-51` literally: "MiMC over BabyBear gives ~field-size security; **production should use Poseidon2**… audited round constants/counts" |
| Merkle / MMCS (commitment scheme) | `zkp-vault/src/lib.rs:66,101-103` | **Keccak** (`KeccakF`, `Keccak256Hash`) | `PaddingFreeSponge<KeccakF,25,17,4>` + `Keccak256Hash` |

The "frozen KAT" `0x32ed1341` cited in memory is a **hardcoded label string** in `tests/proof-drain-service.test.ts` (Beat 10 finding, re-confirmed), **not a computed cross-language hash**. There is no TS↔Rust Poseidon2 parity artifact to "complete" — 4.0 is a **from-scratch dual implementation**, not a 70%-done finish.

### 1.2 "Plonky3 pin rev = 27d59f7350 (13 p3-crates lockstep)" → **FALSE for `zkp-vault`. It pins crates.io `0.3.0`.** [V]
`zkp-vault/Cargo.toml:8-19` declares every `p3-*` dep as `"0.3.0"`. `Cargo.lock` resolves **all** of them to `source = "registry+https://github.com/rust-lang/crates.io-index"`, version `0.3.0` — **zero `git+` sources, zero occurrences of `27d59f7`.** The `27d59f7350` git rev was an earlier custom-STARK salvage branch (see `reports/2026-06-06/CUSTOM_STARK_SALVAGE_MEMO.md`); the *current* prover is on the **crates.io 0.3.0 release line**. This matters: the Poseidon2 oracle must match **p3-poseidon2 0.3.0**, not whatever a git rev exposed.

### 1.3 "zkp-vault proves a tier/score" → the actual statement is **human-anonymous ownership (Semaphore-style), no reputation in-circuit.** [V]
`zkp-vault/src/lib.rs:7-26`: public inputs = `(context, nullifier, {C_0..C_{M-1}})`; private witness = `(secret, agent_id)`; proves `leaf = H(secret, agent_id)` ∈ the public commitment set **and** `nullifier = H(secret, context)`. Cargo.toml's one-line description ("prove a tier/score is valid without revealing the score") is stale vs the source. The **leaf hash `H`** is the MiMC of §1.1 — that is precisely the function 4.0 replaces with Poseidon2.

> **Net:** 4.0 is "implement Poseidon2-over-BabyBear in TS + Rust with bit-exact parity, then swap it in as the leaf/nullifier hash `H`." Not a finish; a build. Scope it accordingly.

---

## 2. THE PARITY ORACLE — get this right or the whole task is worthless

The make-or-break for 4.0 is a **trustworthy cross-language oracle**. A self-referential KAT (TS hashes X, Rust hashes X, compare — both wrong the same way) proves nothing. The oracle must be an **independent ground truth**.

**The oracle is `p3-poseidon2` 0.3.0's `Poseidon2BabyBear`.** [V it's available]
- `p3-poseidon2` `0.3.0` is **already in `zkp-vault/Cargo.lock`** (transitive via `p3-baby-bear`; checksum `88e9f053…`). Promoting it to a direct dep is a one-line `Cargo.toml` add at the **same version already locked** — zero version-drift risk.
- p3-poseidon2 0.3.0 ships **fixed, published round constants** for BabyBear (the Horizen-Labs constant tables `HL_BABYBEAR_{16,24}_EXTERNAL/INTERNAL_ROUND_CONSTANTS`) via the default `Poseidon2BabyBear<WIDTH>` constructor. These are the canonical constants — **do NOT hand-transcribe constants from a Poseidon2 paper** (BabyBear instances are implementation-specific; the paper's BN254/BLS constants are the wrong field).

**KAT generation protocol (the ONE trustworthy path):**
1. Tiny Rust harness (a `#[test]` or `examples/kat.rs` in `zkp-vault`, direct-dep `p3-poseidon2`): construct `Poseidon2BabyBear::<16>::default()`, feed a fixed input vector (e.g. `[0,1,2,…,15]` as BabyBear elements), print the 16-element permutation output as canonical u32s. This output **IS** the oracle KAT — it comes from the audited reference impl, not from our code.
2. TS Poseidon2 must reproduce that exact output element-for-element (BabyBear arithmetic mod `p = 2^31 − 2^27 + 1 = 2013265921`).
3. Only when TS matches the p3-generated vector is parity real. Commit the generated KAT vector + the harness that produced it, so the oracle is reproducible.

**Width decision (open — for the dedicated beat):** BabyBear Poseidon2 standard widths are **16** and **24**. For a 2-input leaf `H(a,b)` you need a sponge/compression over width ≥ 3; width-16 (`Poseidon2BabyBear<16>`) is the p3 default and matches how the existing Keccak MMCS is width-configured. Pick 16 unless the aggregation tier (Plonky3 recursion) dictates 24. **Confirm against what p3's own Merkle/FRI machinery expects** before committing — a width mismatch downstream is the expensive kind of wrong.

---

## 3. BUILD ORDER (for the dedicated, un-bounded 4.0 beat)

Sequenced so each step has an independent check before the next depends on it. **TS + published-vector validation FIRST (cheapest to verify), Rust parity SECOND, in-circuit swap LAST (most expensive, most dangerous).**

| Step | Deliverable | Independent check (the gate) | Risk |
|---|---|---|---|
| 4.0-a | Rust KAT harness → generate the canonical `Poseidon2BabyBear<16>` permutation output for fixed inputs | `cargo test` prints deterministic u32 vector; re-runs identical | low (uses audited ref impl) |
| 4.0-b | TS `poseidon2-babybear.ts` — BabyBear field ops (add/mul/`x^7` S-box mod 2013265921) + external/internal round layers + the HL constants | TS unit test reproduces 4.0-a's vector **bit-exact** | **high** (field arithmetic + MDS/diffusion; subtly-wrong is the default outcome) |
| 4.0-c | Wire TS Poseidon2 as the **commitment leaf** (`src/zkp/commitment.ts`), dual-write behind a flag (sha256 stays primary; poseidon2 shadow-computed) | both hashes emitted; existing 0x-hex path unchanged until flip | low (additive, shadow-first — mirrors every other loop breaker) |
| 4.0-d | Rust: replace `mimc_hash`/`commitment`/`nullifier` (`lib.rs:139-152`) with Poseidon2; **the in-AIR `eval` MiMC rounds (`:188-216`) must change too** | `cargo test` (all 6 GATE tests still pass) **and** the leaf value == TS 4.0-b for shared inputs | **very high** (in-circuit Poseidon2 AIR is a much bigger lift than the clear-text hash — the round structure, S-box, and linear layers all become constraints) |
| 4.0-e | Migration: dual-write parity on real POSTCARD rows, red-team, then flag `POSEIDON2_PRIMARY_HASH` (backlog 4.2/4.3); old sha256 rows stay valid | shadow → 100-proof red-team → flip | governance (Sean gate) |

**Scope honesty for the dedicated beat:** 4.0-a→c (commitment leaf parity) is the "leaf" the backlog names and is achievable in one focused beat. **4.0-d (the in-AIR hash) is a separate, larger circuit rewrite** — the current AIR has MiMC's degree-7 rounds baked into `OwnershipAir::eval` and `generate_trace`; Poseidon2's external/internal round split is a different constraint system (and changes `W`, the column layout, and `log_blowup`). Do **not** promise 4.0-d in the same beat as 4.0-a→c. The backlog's 4.1 ("leaf → Plonky3 STARK aggregate → verify") depends on 4.0-d, not just the clear-text leaf.

---

## 4. OPEN DECISIONS (surface at 4.0 start; not blocking this artifact)
1. **Width 16 vs 24** (§2) — default 16; confirm vs aggregation tier.
2. **Does the in-AIR hash (4.0-d) migrate now, or only the off-circuit commitment leaf (4.0-c)?** ZKP_ARCHITECTURE_INVARIANTS Invariant 1 wants Poseidon2 "both tiers," but the commitment-leaf swap delivers the "aggregation-ready leaf" value first at a fraction of the risk. Recommend: land 4.0-a→c, then treat 4.0-d as its own beat. Vision-adjacent → flag for Sean, don't decide autonomously.
3. **Merkle/MMCS stays Keccak or also moves to Poseidon2?** Invariant 1 implies Poseidon2 for the field-native path, but the Keccak MMCS is load-bearing and audited; changing it is out of 4.0's scope. Leave Keccak; note as future.

---

## 5. WHAT THIS ARTIFACT CHANGES
- **Corrects 3 stale canon facts** (§1) with on-disk `[V]` evidence — memory/STATE said "Poseidon2 ~70% built / pinned to git rev 27d59f7350 / KATs frozen"; reality is **no Poseidon2 exists, crates.io 0.3.0 not a git rev, KAT is a label string.**
- **Defines the correct oracle** (§2) so the eventual implementation is validated against p3-poseidon2, not itself — the single most important de-risking decision.
- **Sequences the build** (§3) with a per-step gate and an explicit warning that the in-AIR swap (4.0-d) is a separate, larger beat than the commitment-leaf parity (4.0-a→c).

**No code, no PR, no unvalidated crypto shipped** — consistent with "7 PRs already await Sean; don't stack an 8th; prefer apex work or verify-first diagnostics." This is the apex-track research that makes the next hard beat bounded.

*Micah 6:8 · verify before asserting · evidence over claims.*
