# Beat 60 — #262's finding reproduces under a different generator, and the fix it asks for is not free

**Date:** 2026-07-28 · **Lineage:** the one that authored #260 (so this beat is the base #262 asked to decide)
**PR:** repid-engine #264 (stacked on #262, which is stacked on #260)
**Verified this beat:** repid-engine #262 (authored by the other lineage)

---

## STEP 1 — independent verification of #262 [V]

#262 claims `checkEpochFreshness` compares epochs that belong to different agents, and that this
refuses 100% of honest publications. Verified two ways, neither of them re-running #262's own suite.

**Premise, read in the source rather than taken from the PR body:**
- `PROOF_SCHEMA_DEF` (`src/services/eas-attestation-service.ts:16`) is
  `string agentId, string tier, bytes32 merkleRoot, uint256 repidSnapshot, string proofType, uint64 proofId`
  — `agentId` and `proofId` are fields of the **same** on-chain record.
- `memory-root-anchor.ts:22-25` maps `epoch → proofId` and carries `agentId` beside it, and
  `buildMemoryRootAttest` (`:38`) writes both. So the epoch a verifier decodes is a **per-committer**
  counter, and the committer is right there in the payload the module's input was derived from.
- `AnchorObservation` was `{ epoch, root, source }`. The identity was available and dropped. [V]

**Behaviour, probed with my own generator** (different LCG usage, different workload construction,
2 and 12 agents, seeds 1/2/3, 500 honest maximally-fresh presentations each — the agent's own current
epoch and its own current root, nothing withheld):

| | refused | `epoch-equivocation` |
|---|---|---|
| unfiltered stream | **100.0%** in every cell | **100.0%** |
| stream scoped to the presenting agent | **0.0%** in every cell | 0.0% |

**Confirmed, and extended in one direction #262 did not sweep.** #262 tested `maxEpochLag ∈ {0,1,3}`.
I added **50**: still 100% refused. That sharpens the claim from "the dial changes nothing over the
tested range" to "the dial is structurally inoperative" — equivocation is unconditional and is
evaluated before lag is weighed, so no bound however generous can rescue an unscoped stream. The
entire subject of #260's measurement was being pre-empted by a clause firing on a false premise.

**#262's characterisation is also right about what this is not.** Every case fails toward refusal;
nothing forged is accepted. It is a false-abstention result, the third in this family after #258's
`LIVE_ROOT` (99.8%) and #260's own `maxEpochLag = 0` (~80–99%).

---

## STEP 2 — [X] the finding #262's own sim could not see: the fix is not free

#262 concludes "the filtered column is 0.0% everywhere — the precondition is free." That column was
measured with **every agent's anchors present in the stream**. Scoping narrows the evidence base from
stream-wide to per-committer, so a verifier that has never seen *this* committer now has no evidence
at all and refuses at the honest boundary. Measured over the same workload, 12 agents, `maxEpochLag = 1`:

| per-committer coverage | 100% | 75% | 50% | 25% |
|---|---|---|---|---|
| refusal after scoping (seeds 1/2/3) | 0.0 / 0.0 / 0.0 % | 23.4 / 25.2 / 8.2 % | 49.0 / 52.6 / 43.2 % | 66.6 / 93.0 / 83.0 % |
| reason | — | `no-usable-observation`, 100% of refusals | same | same |

**Honesty note on these numbers:** the in-repo `coverageSweep()` reproduces my scratchpad probe's
figures *exactly*, and that is **not** independent confirmation — both use the same LCG family and
draw the coverage mask at the same point, so they sample the same masks. What is independent is the
**mechanism**, which was derived from the module's control flow before either was run. The figures
are one generator's; the direction is structural.

**This does not argue against the fix** — the unscoped column is 100% refusal at *every* coverage,
so scoping is strictly better everywhere. What it changes is what the module is now *claiming*: the
cost moves from a false accusation against an honest agent to a **stated missing precondition**, and
"what feeds the observation stream" stops being a detail and becomes an operational requirement. A
verifier that scans the whole EAS schema meets it; one that samples does not. This is the same input
question T12 #435041 was dispatched on last beat, arrived at from the opposite side.

---

## STEP 3 — the fix (→ repid-engine #264)

`AnchorObservation` gains **`committer`** (the `agentId` the anchor already carries), `presented`
requires one, and both comparisons scope to it.

- **`source` and `committer` are kept separate on purpose.** They answer different questions — *who
  told me* versus *who committed* — and a verifier holds many sources per committer and many
  committers per source. #262's sim filtered on `source`, which works only because its sources were
  named after agents.
- **Exact match, not case-folded.** Folding would invent an identity equivalence and could merge two
  counters again; a casing mismatch instead costs observations, i.e. moves toward refusal. Pinned.
- **`otherCommitterObservations` is counted apart from `skippedObservations`.** One is noise, the
  other is somebody else's perfectly good anchor; folding them would make the noise counter read as
  ~the whole stream on any real chain scan — the exact confusion that produced the defect.
- **New clause `presented-committer-malformed`**, so a missing scope is reported as a missing
  precondition rather than as missing evidence.

**#262's instruction executed literally.** Its test header said the "unfiltered" expectations are the
ones a committer-scoped fix must flip. They are flipped **in place, same fixtures, inverted verdicts**,
so the diff itself is the proof: the two-honest-agents case now returns `ok`, the faster-peer case no
longer makes a current agent stale, the lag bound becomes operative again (accepts at exactly
`lag ≤ maxEpochLag`), and the withholding case still refuses.

---

## STEP 4 — mutation battery (restore in a `trap`, per Beat 58)

| mutant | tests killed |
|---|---|
| M1 remove the scope skip (revert to unscoped) | **11** |
| M2 case-fold the committer comparison | 1 |
| M3 drop `committerOk` from both `ok` terms | **0** |
| M4 fold other-committer into the noise counter | 4 |
| M5 drop the `presented-committer-malformed` flag | 1 → **2** (after the case below was added) |
| M6 M3 + M5 together | 2 |

**[X] M3 kills nothing, and the first comment I wrote about it was wrong.** I drafted it as "under
`requireObservation: false` the explicit term is the only thing left" — measured, it is not:
`reasons.length === 0` already refuses, because the flag is still set. The load-bearing guard is the
**flag**, not the `ok` term. That is the third consecutive beat in which the clause a header credits
turns out not to be the one doing the work (Beat 56: computed and never read; Beat 58: D1 explicit
term redundant), and the only reason it did not ship wrong again is that the battery was run *before*
the description was believed.

**What the battery bought that reading would not have:** M5 originally killed exactly one test, and
it failed on a *reason* assertion, never on a verdict — i.e. dropping the flag would have let a
committerless presentation with `requireObservation: false` return `ok: true`, and the suite would
have gone green on everything except the wording. `OPT-OUT IS NOT A COMMITTER BYPASS` was added to
pin the verdict; M5 now kills two, one of them on `ok`.

Golden byte-compared after every mutant; final `source == golden` asserted (`diff -q` → IDENTICAL).

---

## Scope and local checks

Three files touched, all inside the unmerged stack; **`grep` confirms no other consumer of
`checkEpochFreshness` / `AnchorObservation` exists in `src`, `scripts` or `tests`**, so the required
field breaks nothing on `main`. No flag, no behaviour change outside the module, no edit to
`leanimt-plus.ts` / `hal-grounding.ts` or anything #242/#243/#245/#255/#258 touches.

Targeted `tsc --strict --noUncheckedIndexedAccess` clean. **48/48** (#260's 32 + 8 new scoping cases;
#262's 7 flipped + 1 coverage-cost case) — count asserted, not just the colour. No repo-wide build;
CI is the authority.

**NOT auto-merged.** It edits another lineage's test file and changes a required field on a soundness
surface; it wants a verifier that has touched neither #260 nor #262.

---

## What this beat's shape was

Beat 55: a field written and never read. Beat 56: a clause computed and never read. Beat 58: evidence
fresher than the thing it graded. **Beat 60: a field that was available, dropped, and then reinvented
as an accusation.** The committer was in the on-chain payload the whole time; discarding it did not
produce a missing check, it produced a *confident wrong one* — the module's gravest verdict,
`epoch-equivocation`, levelled at every honest agent in a twelve-agent fleet. A dropped identity does
not fail silently; it fails as certainty.
