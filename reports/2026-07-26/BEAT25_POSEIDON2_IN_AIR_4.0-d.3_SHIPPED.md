# Beat 25 — 4.0-d.3/4.0-d.4 shipped: the ownership circuit's in-AIR hash is now Poseidon2

**Date:** 2026-07-26 · **Author:** Claude (autonomous build-loop, Beat 25) · **Branch:** `feat/cc-2026-07-26-poseidon2-in-air-4.0-d` (pushed, **no PR opened** — see §5) · **Commit:** `74f7af9`

This closes the last open sub-step of backlog 4.0-d and, with it, the make-or-break of ZKP Invariant 1 for the ownership vertical: **one hash, one field, in-circuit and off-circuit, bit-identical.**

---

## 1. What shipped

`zkp-vault`'s `OwnershipAir` proved `leaf = H(secret, agent_id)` and `nullifier = H(secret, context)` with a hand-written MiMC (`x^7`, R=12, Miyaguchi–Preneel, W=27) that the crate's own scope note flagged as non-production. It now uses

```
H_p2(a, b) := Perm16([a, b, 0, …, 0])[0]
```

— the *same* Poseidon2-BabyBear hash the KAT oracle commits (4.0-d.1) and the TypeScript port is gated against (4.0-d.2). Round constraints come from the audited `p3-poseidon2-air` 0.3.0 `Poseidon2Air`, **not** hand-rolled.

## 2. The design finding that Beat 19's spec got wrong

Beat 19 recommended **Layout A**: two `Poseidon2Cols` blocks side-by-side in one row plus glue columns, calling the wrapper "a handful of custom boundary constraints." **Layout A is not implementable against 0.3.0** [V]: the gadget's constraint entry point (`air.rs:108 pub(crate) fn eval`) is crate-private, and the only public path is `impl Air for Poseidon2Air`, which does `main.row_slice(0)` and borrows the **entire row** as `Poseidon2Cols`. Embedding it as a sub-block would require a `SubAirBuilder` shim (a column-range view implementing `AirBuilder`) — real work the spec did not budget.

**The layout actually shipped avoids the shim entirely** by making the trace row *be* the gadget's row and expressing the ownership statement with **zero added columns**:

| row | permutation | input lanes | output lane 0 |
|---|---|---|---|
| 0 (first) | leaf | `[secret, agent_id, 0…]` | `leaf`, constrained ∈ `{C_j}` |
| 1.. | nullifier | `[secret, context, 0…]` | must equal the public nullifier |

`secret`/`agent_id`/`context` are permutation *inputs*; `leaf`/`nullifier` are its *outputs*. The statement is then only first-row and transition constraints. **Trace width 27 → 299, but the glue costs 0 of those columns.**

**The one new soundness mechanism.** Under MiMC both hashes shared a literal `secret` cell on a single row. Poseidon2 needs one permutation per row, so the binding moved to a transition constraint `next.inputs[0] == local.inputs[0]`. That single line is what stops a prover from proving membership with one human's secret while publishing a different human's nullifier.

## 3. Gates (all green, adversarially checked)

- **`circuit_matches_off_circuit_h_p2`** — reads the *real committed witness* out of `generate_trace()` and requires it to equal `commitment()`/`nullifier()` over 4 input sets incl. `(0,0,0)`. This is the Invariant-1 make-or-break: without it a proof could verify against its own trace while failing against an off-circuit commitment set.
- **`commitment_agrees_with_kat_level_h_p2`** — the field-level and u32-level wrappers cannot diverge. `h_p2` was hoisted to `h_p2_field` so circuit witness generation and the KAT-gated form are literally one function (continues Beat 23's single-definition discipline).
- **`nullifier_must_use_the_same_secret_as_the_leaf`** — forges a trace whose nullifier rows hash a *different* secret while publishing that impostor's nullifier (so every other constraint is satisfied) and requires rejection. Fails at `check_constraints.rs:103`, "constraints had nonzero value on row 0" — the transition pair.
  - **Mutation-tested [V]:** with `trans.assert_eq(next.inputs[0], local.inputs[0])` deleted, the forgery becomes **provable** ("test did not panic as expected"). The test gates that exact line, not something incidental. Source restored; `git status` clean.
- **All 6 pre-existing GATE tests stay green** — they assert behavior, not MiMC internals, so they are the regression gate for the rewrite.
- **Totals:** `cargo test` **21/21** (10 lib incl. 3 new + 5 2-to-1 KAT + 6 leaf KAT), `cargo build` clean.

**Highest-risk integration point, closed [V]:** the gadget must be fed the *same* round constants as `default_babybear_poseidon2_16()`. `RoundConstants::new(BABYBEAR_RC16_EXTERNAL_INITIAL, BABYBEAR_RC16_INTERNAL, BABYBEAR_RC16_EXTERNAL_FINAL)` + `GenericPoseidon2LinearLayersBabyBear` reproduces `h_p2` exactly — verified by a standalone probe *before* the rewrite was written, then permanently by the parity gate.

## 4. Beat 19's two `[R]` unknowns, now `[V]`

| Unknown | Resolved |
|---|---|
| const generic list | `Poseidon2Air<F, LinearLayers, WIDTH, SBOX_DEGREE, SBOX_REGISTERS, HALF_FULL_ROUNDS, PARTIAL_ROUNDS>` — exactly as guessed (`air.rs:19-27`) |
| BabyBear LinearLayers re-export name | **`GenericPoseidon2LinearLayersBabyBear`** (`p3-baby-bear-0.3.0/src/poseidon2.rs:54`) |

Instance: `WIDTH=16, SBOX_DEGREE=7, SBOX_REGISTERS=1, HALF_FULL_ROUNDS=4, PARTIAL_ROUNDS=13`. `SBOX_REGISTERS=1` commits `x^3` and holds every gadget constraint at degree ≤ 3, so **`log_blowup=3` stays valid — no PCS change**, as the spec predicted.

**One spec assumption corrected:** the statement needs only 2 rows, but FRI asserts `log2(HEIGHT) > log_final_poly_len` under this config, so `HEIGHT=2` panics (`p3-fri` `prover.rs:65`). `HEIGHT=8` is the smallest legal height — unchanged from MiMC, so height is not a regression.

## 5. 4.0-d.4 — measured cost, not guessed

Release build, identical config/height/group, same machine:

| | MiMC (baseline, `46b212a`) | Poseidon2 (`74f7af9`) | Δ |
|---|---|---|---|
| prove | 2.9 ms | 5.3 ms | **1.8×** |
| verify | 0.3 ms | 1.0 ms | **3.3×** |
| proof size | 8,854 B | 19,734 B | **2.2×** |
| trace width | 27 | 299 | 11.1× |

The trace is 11× wider but the proof only 2.2× — FRI amortizes the column count. Single-digit-millisecond proving either way; **the cost is not a reason to keep a hand-rolled hash.**

**No PR opened.** Nine loop PRs (#189, #191–#198) still await Sean, nothing has merged since #188, and this branch is stacked on #197 — a PR now would display #197's commits and would hit the same squash-vs-stack conflict Beat 22 documented. It becomes PR #199 the moment #197 merges. (Beats 21–24 discipline: don't grow a stalled queue.)

## 6. Carried-forward finding from Beat 24: **REFUTED, not fixed**

Beat 24's verifier flagged the KAT line-scan parser as "exact only under the generator's current `a → b → output` field order — a reorder could silently mis-pair values." Tested empirically (throwaway tampering, artifact restored):

- **Swap the `a`/`b` values, keys unchanged** → `committed KAT vector (2,1) does not match the raw permutation — the oracle drifted` **FAILS loud.** (`H_p2` is not symmetric, and the gate recomputes from the parsed pair.)
- **Move `output` ahead of `a`** → `KAT vector has 'output' before 'a'` **FAILS loud.**

The parser is **key-based, not positional** (`strip_prefix("\"a\":")`), so a reorder either preserves correct pairing or panics explicitly. No silent mis-pairing path found. Recording this as refuted rather than shipping a fix for a non-bug.

## 7. Honest limits

- The field is still BabyBear (~31 bits). Soundness rests on the FRI/extension parameters, not the base field, but a larger field remains the conservative production choice — unchanged by this beat.
- FRI still uses low-blowup test parameters: correct for the gate + benchmark, not production soundness. Unchanged, and still the honest scope note in the crate docs.
- Membership is still a vanishing product over a small public set (degree = group size); a Merkle path is the production shape for large groups. Unchanged.
- The `export` column the gadget writes is unconstrained by this statement. Harmless (an unconstrained committed column cannot weaken the constraints that exist), but noted so a future reader does not mistake it for a selector.
- The 2-scalar lane convention (absorb 0/1, read 0) is a design choice with no external canon to check against; the gates prove *self-consistency across all three surfaces*, which is what Invariant 1 actually requires.
