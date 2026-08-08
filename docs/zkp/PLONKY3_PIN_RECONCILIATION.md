# Plonky3 pin reconciliation (ZKP Invariant 5)

**Invariant 5 (ZKP_ARCHITECTURE_INVARIANTS):** *one Plonky3 pin governs ALL Plonky3
circuits.* A single revision must bind every circuit so a leaf produced by one crate is
aggregation-compatible with every other, and no crate can silently drift the pin and
break the others.

## The divergence the audit found (audit item #7)

There are **two** Plonky3 pins in play, on two different mechanisms:

| Tier | What it governs | Pin mechanism | Value |
|---|---|---|---|
| **Aggregation / prover** | `zkp-postcard` (deployed prover) + `@hyperdag/proof-verifier` WASM | Plonky3 **git rev** (CANON P-026 lockstep) | `27d59f7350` |
| **Leaf (in this repo)** | `zkp-vault` (Poseidon2-BabyBear leaf KAT crate) | **crates.io** `p3-* = "0.3.0"` family | `0.3.0` |

"Same family, different mechanism" — the leaf tier resolves the `p3-*` crates from
crates.io `0.3.0`, while the canonical aggregation pin is a git revision. This is the
Invariant-5 violation: two pins where the invariant requires one.

## Why it is NOT collapsed tonight (branch-safe decision)

Collapsing `zkp-vault` onto the git rev `27d59f7350` is **not** a safe overnight change:

1. `27d59f7350` was the abandoned custom-STARK salvage branch
   (`reports/2026-07-25/AUTONOMOUS_LOOP_LEDGER.md`); its `p3-*` API is not guaranteed
   API-compatible with the crates.io `0.3.0` release `zkp-vault` builds against today.
2. `zkp-vault` is currently a **leaf-hash KAT crate** whose Poseidon2-BabyBear vectors
   are frozen bit-exact against p3 `0.3.0`. Repinning to a different revision risks
   breaking those frozen KATs — the exact "expensive kind of wrong" the leaf work warns
   about.
3. The leaf is **not yet wired into the aggregation tier**, so the two pins do not yet
   have to agree at runtime. The reconciliation belongs at **leaf-wiring time**, done
   deliberately with the KATs re-frozen against the chosen revision — not as an
   incidental repin.

Reconciliation target: when the Poseidon2 leaf is wired into Plonky3 recursion, move
`zkp-vault` onto the single canonical pin (git `27d59f7350`, or whatever the aggregation
tier is re-pinned to at that time) and re-freeze the leaf KATs against it. Only one pin
survives.

## The guard that keeps this honest

`tests/plonky3-pin-single-source.test.ts` machine-checks two things so the divergence
can neither silently worsen nor silently "resolve":

1. **Within `zkp-vault`, all `p3-*` crates share ONE version and ONE source** — the
   invariant applied to the in-repo crate. It fails loudly the moment anyone mixes a
   second pin mechanism (a `git+` source alongside the registry, or two `p3-*`
   versions) into `zkp-vault/Cargo.lock`.
2. **The known cross-tier divergence is pinned to the state described here.** If someone
   collapses `zkp-vault` onto the canonical git rev (the good outcome), the guard fails
   and forces this doc + the manifest to be updated to `reconciled` — making
   reconciliation a reviewed, recorded act rather than a silent flip.
