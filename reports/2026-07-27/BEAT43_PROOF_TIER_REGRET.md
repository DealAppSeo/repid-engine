# Beat 43 — Measured regret for the proof-tier policy, and the claim cap sent back

**Date:** 2026-07-27 · **Branch:** `feat/cc-2026-07-27-proof-tier-regret` → PR #228 (stacked on #225)
**Reproduce:** `npx tsx scripts/measure/proof-tier-regret.ts` · `npx jest --config jest.config.js tests/proof-tier-regret.test.ts`

---

## 1. Why this exists

The patent backlog's enabling-disclosure note asks that Patent #2 be documented with
**measured cost/reliability numbers** — "ANFIS regret vs shadow" — not only with properties.
#225 delivered properties: the safety floor holds, the ladder is monotone, all five rungs
are reachable, swept over a 32,768-point grid. That is necessary and it is not regret.

A grid cannot produce regret, because regret needs a notion of what the *right* answer was
and a grid has none. Every point on the grid is equally valid input; none of them is
labelled. So the missing ingredient was an oracle, and the only honest way to get one was
to write it by hand from the semantics of real calls.

## 2. The corpus, and why it is committed separately

`src/services/proof-tier-corpus.ts` — 30 scenarios across the actual product surfaces
(TrustChat, TrustMarket, x402 escrow, proof-carrying retrieval, TrustRepID, TrustMedical,
the leaderboard, the swarm). Each carries a `requiredTier` declared from the **weakest rung
sufficient for that answer to be trustworthy**, plus a `why` a reader can check without
running anything.

The labelling rule is stated once and applied per scenario:

| rung | when it is required |
|---|---|
| `none` | the answer asserts no fact drawn from committed memory |
| `inclusion` | it cites a stored fact that is **immutable** once written |
| `current_validity` | it cites a fact that is **revocable** — must be proven un-retracted NOW |
| `authenticated_walk` | the answer is **derived by traversing links**; each hop must verify |
| `ranking_integrity` | the answer asserts an **order** over a set |

**A regret measurement is the most riggable artifact this loop has produced.** Whoever
writes both the labels and the policy can make the policy look arbitrarily good by moving
the labels. Two structural defences, neither of them a promise:

1. **The corpus imports nothing** — in particular not `proof-tier-policy` — so a label
   cannot be derived, even transitively, from the code it judges. Enforced by a test that
   reads the file, not by the comment at the top of it.
2. **It was committed in its own commit (`c629104`), before any scorer existed.** The
   history is the evidence that the labels were not tuned to the numbers they produce.

Five scenarios are deliberately built to embarrass the policy rather than flatter it: the
axes pull *against* the requirement (consequential-but-broke, cheap-but-trivial,
high-reliability/low-stakes, private-but-immutable, urgent-and-trivial).

## 3. The measurement

Oracle cost (perfect play) = **244 units** over 30 scenarios.

| strategy | exact | under | over | overCost | totalCost |
|---|---|---|---|---|---|
| `always_none` | 6 | 24 | 0 | 0 | 0 |
| `always_max` | 4 | **0** | 26 | 956 | 1200 |
| `fixed_current_validity` | 10 | 8 | 12 | 30 | 90 |
| **`floor_only`** (no learned layer) | **20** | 9 | 1 | 2 | 61 |
| `learned_only` (no gates) | 13 | 1 | 16 | 304 | 520 |
| **`policy`** (shipped) | 14 | **1** | 15 | 295 | 511 |

**The ablation is the point.** Patent #2 claims a *unified learned fabric* selects proof
strength. The honest test of that is not "does the policy do well" — a deterministic floor
alone might do as well, in which case the learned layer is decoration and the claim is
weaker than stated. So `floor_only` is measured as a first-class competitor.

It is not decoration: the learned layer takes under-proofs from **9 → 1**. It also pays
about **8x** for that (61 → 511 units). Neither strategy dominates, so any single scalar
would hide the trade rather than disclose it.

### The number worth filing

Regret = over-proof cost + *p* × under-proof count is **affine in *p***, so any two
strategies cross at most once and the crossing is exact rather than searched for:

| vs | ties at | policy wins |
|---|---|---|
| `always_none` | 12.8 | above |
| `floor_only` | 36.6 | above |
| `fixed_current_validity` | **37.9** | above |
| `always_max` | **661.0** | below |
| `learned_only` | parallel | — |

> **The policy is the regret-minimising strategy iff an under-proven claim costs between
> ~37.9 and ~661 units.** Outside that band a named rival wins.

This converts "the policy is better" — true only over a band — into something a reader can
price for themselves and can falsify. And the lower edge lands just under the cost of the
dearest proof on the ladder (40 units), which states the thesis in one line: **proving is
worth paying for exactly when being wrong costs more than the proof does.**

## 4. Two limitations, pinned as literals

Both are pinned deliberately, so that *fixing* one **fails** the suite and forces the
disclosure to be updated rather than quietly going stale.

**(a) The deterministic floor never binds on real traffic.** It fires 3,092 times on
#225's synthetic grid and **0 times across all 30 real scenarios**. Both numbers are true
and the gap is the finding: the learned layer over-proves so consistently that the safety
gate is never the binding constraint. The floor still earns its place — it is what makes a
*drifted* policy safe rather than merely an observed-to-be-safe one — but claiming a
measured contribution here would overstate the shipped system.

**(b) The one residual under-proof is out of the floor's structural reach.**
`best-provider-route` requires rung 4; `floorTierIndex` ranges over {0,1,2} — swept in the
test rather than read off the source, so the claim survives someone editing the function.
The requirement comes from the **shape** of the claim (an ordering over a set), and the
floor has no input for shape — only stakes and reliability. **A shape-keyed floor rung is
the fix**, and it is the obvious next increment for Patent #2.

## 5. Mutation battery — and the hole it found in this suite

12 mutations, each confirmed landed by `git diff` before judging (the files are CRLF,
where a `,\n` pattern silently fails to match — the trap that cost Beat 42 four wasted
mutations). Source restored and hash-verified after each.

**9 killed on the first pass**, including M1 — replacing `anfisForward` with a one-rule
linear sum, *the mutation that survived all 18 of #225's original tests*. Here it dies to
four tests.

**The three survivors were the finding.** M2 (delete the high-stakes floor rung) and M11
(never apply the floor) both survived, because `floorFirings === 0` is equally true of a
floor that never binds **and** of a floor that has been deleted. That is the exact
weaker-property-than-claimed failure this suite was written in reaction to — reproduced
inside the suite itself, on the first try, by me. Closed with two witnesses, each chosen so
that a single floor rung is the sole binding cause; both mutants now die, each to exactly
one test, so the new pins are precise rather than over-broad.

M3 (drift `PRIVACY_ZK_THRESHOLD` 0.6 → 0.95) still survives **here, on purpose**: this
suite declines to score `zkRequired` because the corpus carries no independent zk label,
and scoring it against the policy's own threshold would be the self-referential oracle the
whole design avoids. #225's suite kills M3 — **verified by running it, not assumed**
(re-run of all three survivors against both suites: 3/3 killed, 40 tests).

## 6. Verification

`tsc --noEmit` exit 0 · `tests/proof-tier-regret.test.ts` **21/21** · nothing in `src/`
imports the new modules · no `process.env` reads · additive-only (0 deletions) · the three
failing suites in the full 2,518-test run are live-Supabase (`ECONNREFUSED` against the
dummy URL), confirmed **by cause** rather than assumed branch-independent.

## 7. What this does NOT establish

- The labels are mine. They are argued in `why` and structurally insulated from the
  policy, but a second labeller has not reviewed them. **That is the highest-value
  independent check on this PR** and it is what the next beat should commission.
- 30 scenarios is a small corpus. The crossover band is exact *given these labels*; its
  sensitivity to relabelling is unmeasured.
- `TIER_COST_UNITS` is a stipulated cost ladder, not a measured one. Every cost figure
  above inherits that stipulation. Measuring real prover time per rung would make the
  band an economic statement rather than a relative one.
- Nothing here is wired to a live path. The policy remains inert and Sean-gated.
