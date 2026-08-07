# Trust Harness E2E — MVP verified runnable against live infra

**Date:** 2026-08-07
**Branch:** feat/cc-2026-08-06-holdout-local
**Artifact:** `scripts/demo/trust-harness-e2e.mjs` (run via `npm run demo:harness`)
**Method:** `npm run build` (tsc clean) → `node scripts/demo/trust-harness-e2e.mjs` against production
(`repid-engine-production.up.railway.app`, keyless) + local Plonky3/Poseidon2 primitives. No mocks, no fixtures.

## Verdict

All six legs reported REAL. The gate correctly **REFUSED** a false, unanchored claim.

```
legs: hal=REAL  repid=REAL  proof=REAL  nullifier=REAL  anchor=REAL  fold=REAL
```

## Leg-by-leg (this run)

| # | Leg | Result |
|---|-----|--------|
| 1 | HAL cross-provider quorum | **vetoed** the false claim — raw halScore 1 → calibrated P(hallucination) **0.9999**, confidence 0.9999 `[rigorous-v1@596f10de18d0, T=0.8192 bias=0.4079]` |
| 2 | RepID (keyless read) | RepID **2070**, tier ESTABLISHED |
| 3 | ZK range proof | `plonky3_range_check`, **10673 proof bytes**, **verified locally** — asserts RepID ≥ 999 without revealing 2070 |
| 4 | Poseidon2 scoped nullifier | canonical Rust primitive; scope=ownership → 284393528, scope=consent → 1572901508 (same secret, different scope → different nullifier — invariant 2) |
| 5 | On-chain anchor (Base Sepolia) | 12 agents minted, **78 lifetime on-chain writes**; IdentityRegistry `0x8004A8…BD9e`, ReputationRegistry `0x8004B6…8713` |
| 6 | Outcome classify + fold | no payment anchor → FAILURE_AGENT_FAULT, confidence 0.9999, value 500, **delta −119.99**, RepID 2070→1950; fold root 414124072 commits to score 1950 (Poseidon2/BabyBear, verified by the circuit) |
| 7 | Dual-auth gate | agent=OK, human=OK, but **REFUSE** — HAL vetoed; every blocker listed (`hal_vetoed`) so fixing one cannot hide the next |

## Honesty properties demonstrated in-code (not in a doc)

- **Calibrated, not raw:** HAL confidence is temperature-scaled on a frozen holdout (`T=0.8192 bias=0.4079`), carrying its ruler `rigorous-v1@596f10de18d0`.
- **Verified, not asserted:** the ZK proof is fetched and then verified locally — the demo does not take the server's word.
- **Stated limits, not over-read:** the fold leg prints `weighted_update: checked=true binding=false` ("a DECREASE is unrepresentable in unsigned field arithmetic — C2 is vacuous for this step and says so") and `commitment_nullifier=false — BOUND but not derived in-circuit`.
- **Fail-closed:** both authorities present + HAL veto ⇒ still REFUSE. An unavailable safety check is not a passing safety check.

## What this means

Tier-0 is not "to build" — it is built and demonstrated. The MVP is a **packaging** step:

- `npm run demo:harness` added (matches existing `demo:trust` / `demo:own-agent` convention).
- README gains a prominent "Run the trust harness end-to-end" section (the one-command reviewer path).
- The demo file is bin-ready (`#!/usr/bin/env node`).

## Open decision for Sean (publish target — NOT done autonomously)

`package.json` has `private: false` and **no `files` field**, so a bare `npm publish` from this repo would pack
the entire proprietary engine, including the scoring formula (a hard-stop secret). **Do not publish repid-engine
to npm as-is.** The public npm artifact should be a clean wrapper (e.g. `@hyperdag/trustshell`, or a
standalone `trust-harness` CLI package that only imports the public endpoints). Recommend deciding the public
package boundary before any `npm publish`. Publishing is an irreversible public action — left for Sean.
