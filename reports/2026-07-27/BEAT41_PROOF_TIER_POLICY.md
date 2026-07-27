# Beat 41 — Proof-tier selection as a first-class ANFIS policy output (Patent #2 keystone)

**Date:** 2026-07-27 · **Backlog item:** #11 · **Patent:** #2 (policy-gated proof-tier selection via a unified ANFIS/LASSO fabric) · **Status:** built, tested, mutation-tested, **shadow-inert**

---

## What the claim needs, and what was missing

Patent #2 claims that **one** policy fabric decides both the routing axes **and** the required
cryptographic proof strength — inclusion → current-validity → authenticated walk → ranking
integrity — from cost / stakes / privacy / latency / reliability.

Before this beat the repo had one half of that. `src/services/anfis-router.ts` runs the ANFIS +
LASSO fabric over prompt/provider features and emits a **provider and compute tier**. Nothing
emitted a **proof obligation**, so the "unified" in the claim was an assertion about an
architecture that existed on one side only.

`src/services/proof-tier-policy.ts` supplies the other half, and — this is the part that matters
for the claim — it does so by **reusing the same fabric** (`goldenCenters` / `goldenSpreads` /
`anfisForward` from `anfis-comma.ts`), not by standing up a parallel model. Two outputs, one
policy model, one feature-vector discipline.

## The two-layer design

The design decision worth recording is the split between a **learned selector** and a
**deterministic gate**:

1. **Learned layer (ANFIS + LASSO)** *selects* a rung of the ladder. Gaussian antecedents over
   golden-ratio centers, five rules, linear consequents that push up on stakes/reliability/privacy
   and down on cost/urgency, squashed and quantised into the ladder.
2. **Deterministic floor** *gates* it. The learned layer may always select a **stronger** proof
   than the floor and can **never** select a weaker one.

So a mis-tuned, drifted, or adversarially-fed policy can waste money. It cannot silently
under-prove a high-stakes claim. That asymmetry is what makes shipping a learned policy on this
path defensible at all, and it is the same shape as the L0/L2 safety gates already in the repo:
**the learned component is never the last thing standing between a claim and its proof.**

The privacy axis is deliberately **orthogonal** to the ladder — it sets `zkRequired`, not a tier.
A tier says *how strongly* the evidence is proven; `zkRequired` says *whether the evidence may be
revealed at all* (ZKP_ARCHITECTURE_INVARIANTS 2/4 — domain-scoped nullifiers, PHI never in the
clear). Collapsing them into one scale would have been the easy modelling choice and the wrong one.

## Measured properties — swept, not asserted

The behaviour was **measured on a 8⁵ = 32,768-point axis grid before any assertion was written**,
and the test suite then pins what the measurement found:

| Property | Result |
|---|---|
| Non-degeneracy — all 5 rungs reachable | **[V]** all 5 reachable as *learned* choices (5,906 / 6,401 / 7,541 / 7,884 / 5,036) **and** as *effective* ones (4,645 / 5,439 / 11,925 / 6,290 / 4,469) |
| Floor never violated | **[V]** 0 violations / 32,768 |
| Monotone in stakes (raising stakes never lowers the tier) | **[V]** 0 violations / 28,672 adjacent-pair comparisons |
| Monotone in cost pressure (raising cost never raises the tier) | **[V]** 0 violations |
| Both gates load-bearing | **[V]** floor fired 3,092×, ceiling fired 2,161× |

**Honest scope on monotonicity:** this is an *empirical* result over the grid, not an analytic
proof. Gaussian membership functions are not monotone in general, so a monotone ANFIS output is
something to verify rather than assume — which is why it was swept first. The **floor**, by
contrast, *is* analytically monotone: it is a pure step function of stakes and reliability.
The safety property (P3) rests on the floor; the directional properties (P4/P5) rest on the sweep.

## Anti-vacuity — the specific failure this suite is built against

The immediately prior artifact in this repo (#222) passed its central assertion **for the wrong
reason**: a stale answer failed verification via `binding_mismatch` before the inclusion proof was
ever exercised, so a verifier that had stopped checking the root entirely would have shipped green.

The analogous trap here is a **degenerate policy**. A `selectProofTier` that always returned
`current_validity` would satisfy *every* monotonicity and floor property in this suite vacuously.
So two tests exist purely to make that impossible:

- **P1** asserts every rung is reachable, both pre-gate and post-gate.
- **P2** asserts the tier still moves when **neither gate is engaged** — stakes and reliability
  held below every floor trigger, urgency below the ceiling trigger. Anything that changes the
  decision in that region is the ANFIS fabric itself. Without P2, the floors could be doing 100%
  of the work and the "policy" would be a lookup table wearing a fuzzy-logic costume.

## Mutation testing — the suite failed its first battery, and that was the point

Six source mutations were run against the first version of the suite. **Three survived.** Two of
those were real holes in my own tests; the third was an equivalent-code mutation. All numbers
below are from jest's own total line.

| Mutation | First battery | After fixes | What it means |
|---|---|---|---|
| drop the `stakes ≥ 0.35 ⇒ inclusion` floor rung | **SURVIVED** 16/16 | **KILLED** (3 fail) | real hole — see below |
| `quantise` always returns tier 2 (degenerate policy) | KILLED (4 fail) | — | anti-vacuity works |
| ceiling ignores the floor | **SURVIVED** | **SURVIVED** | equivalent code — see below |
| `zkRequired` always false | KILLED (1 fail) | — | privacy axis pinned |
| overwrite `learnedTierIndex` with the final tier | **SURVIVED** | **KILLED** (1 fail) | real hole — see below |
| flatten the cost ladder (12 → 3) | KILLED (1 fail) | — | ladder ordering pinned |
| `citationsDigest` drops citation content *(verifier's find)* | n/a | **KILLED** (1 fail) | see the section below |

**Hole 1 — my safety test was self-referential.** P3 asserted `selectProofTier(a).tierIndex >=
floorTierIndex(a)`. Both sides call the same function, so deleting a floor rung moved the
assertion and the property together and the suite stayed green. **This is precisely the
"passing for the wrong reason" failure I wrote the anti-vacuity tests to prevent, reproduced
inside the anti-vacuity tests themselves.** Fixed by restating the floor as an independent
literal oracle in the test file, plus a test that the implementation and the oracle agree at
every grid point, plus a test pinning the deleted rung specifically.

**Hole 2 — a real assertion hidden behind a guard that never fired.** The gate-effect test read
`if (d.floorApplied) expect(...)`, on axes where the floor did not in fact apply. The guarded
assertion never executed, so overwriting `learnedTierIndex` with the final tier passed. Fixed by
choosing axes where the floor demonstrably bites and turning the guard into an assertion.

**Not a hole — the surviving ceiling mutation is equivalent code.** `floorTierIndex` maxes at 2
and the urgent ceiling is exactly 2, so `Math.max(rawCeiling, floor)` cannot differ from
`rawCeiling` today; the branch is unreachable and therefore untestable. It is kept deliberately
as the invariant that must hold if a future floor rung is ever raised above `current_validity`,
and is now labelled as such in source so no future reader mistakes it for covered ground.
Recorded as a bad mutation, not a finding.

## A gap closed one layer up (from the independent verification of #223)

The verifier that checked Beat 40's work probed the **answer-binding** layer — the Patent #1
keystone — and found that with `citationsDigest` mutated to drop the citation *content*, a forged
claim verified as `{grounded: true, binding_ok: true, verified_citations: 1}`. The property holds
in the shipped code; **nothing pinned it.** The sibling case (tampering a citation *witness*) had
a test; tampering the human-readable claim the proof stands behind did not.

`tests/proof-carrying-memory.test.ts` now has that test, and the mutation that motivated it is
killed by exactly that one test. *Absence of a test is not absence of the property — it is
absence of the alarm.*

## Enabling disclosure (for the filing)

Documented in-code and exercised by tests: the exact 5-axis feature vector; the LASSO importance
weights and selection threshold that produce the named `drivers`; the rule consequent table; the
squash and quantiser thresholds; the floor/ceiling constants; the cost/latency model per rung; and
`learnedTierIndex` retained alongside the final `tierIndex` **so the gate's effect is measurable
rather than invisible**.

## Inertness

Pure function plus a shadow comparator (`shadowCompareProofTier`, mirroring
`computeShadowDecision` in `anfis-router.ts` so both halves of the fabric are measured the same
way). Wired into no live path, reads no env flag, changes no behaviour. Measurement first;
enforcement is a later, Sean-gated step.

## Files

- `src/services/proof-tier-policy.ts` — the policy (new)
- `tests/proof-tier-policy.test.ts` — 18 property tests (new)
- `tests/proof-carrying-memory.test.ts` — +1 test closing the answer-binding content-tamper gap

**[V] Verification:** `npx tsc --noEmit` exit 0 · **7 suites / 65 tests passed**, taken from
jest's own total line (`tests/proof-tier-policy` + the six Patent-#1 memory/HAL suites) · real
Poseidon2-BabyBear via module defaults, no injected hash fakes · mutation battery run twice,
zero residue confirmed by diff against out-of-repo copies both times.
