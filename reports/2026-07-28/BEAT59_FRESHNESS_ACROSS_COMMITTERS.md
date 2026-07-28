# Beat 59 — the freshness check compares numbers that belong to different agents

**Date:** 2026-07-28 · **Subject:** independent verification of repid-engine #260 (`src/memory/epoch-freshness.ts`), which this lineage did not author.
**Method:** read the source, then probe the compiled module directly — deliberately *not* by re-running its own test suite.

---

## 1. #260's own claims — VERIFIED [V]

Every property the PR asserts about `checkEpochFreshness` reproduces under an independent probe
(22 hostile shapes + an 810-shape invariant sweep):

| claim | result |
|---|---|
| withholding is caught (`stale-epoch` past the bound) | ✅ lag 1 vs bound 0 refused; lag 1 vs bound 1 accepted; lag 2 vs bound 1 refused |
| bound is exact, not approximate | ✅ refusal flips at exactly `lag > maxEpochLag` |
| `epoch-equivocation` catches the presentation itself | ✅ conflicting root at the presented epoch names `sourceA: 'presentation'` |
| noise cannot refuse | ✅ 4 malformed rows → `skipped=4`, verdict decided by absence of evidence, not by noise |
| noise cannot rescue | ✅ garbage + one later genuine anchor → still `stale-epoch` |
| fail-closed with no observation | ✅ `no-usable-observation`; `requireObservation:false` moves the verdict, and does **not** rescue a malformed epoch |
| totality | ✅ throwing accessor → `freshness-check-threw`; non-array, null presented, NaN/fractional/negative epoch all yield verdicts |
| bounded **before** the scan | ✅ 65 537-element stream that *would* have been accepted is refused in **0 ms** |
| policy cannot widen the bound | ✅ `maxEpochLag` of `-5`, `Infinity`, or absent all behave as `0` |
| `ok ⟹ reasons empty` | ✅ **810 shapes, 0 violations** |
| `derivedMaxEpochLag` | ✅ `(40,50)→1 (120,50)→3 (200,50)→4`; degenerate inputs → the strict `0` |
| suite size | ✅ **32 tests**, exactly as the PR body states (39 with this beat's 7) |

The Beat-56 defect class (a clause computed, named, and never read) is **not** repeated: a negative
epoch is refused here, and the PR is candid that `epochLag !== null` — not the explicit `epochOk`
term — is what does the refusing.

## 2. [X] THE FINDING: `AnchorObservation` drops the committer, and `epoch` is a per-agent counter

`AnchorObservation` is `{ epoch, root, source }`. `source` is documented as provenance that exists
"to be reported back in evidence, **never to be compared**." So both of the module's comparisons —
newest-epoch and one-epoch-two-roots — are between bare numbers with no notion of *whose* epoch.

But the epoch is not a clock. It is a per-agent commitment counter:

- `memory-root-anchor.ts:25` — "monotonically-increasing epoch → carried as proofId"
- `proof-carrying-memory.ts:56` — the epoch is mixed into each entry's own hash
- `memory-root-anchor.ts:22,38` — the anchor payload carries **`agentId`** beside it

A verifier's anchor stream is a scan of the EAS schema, which returns **every agent's** anchors
interleaved. Two agents reach epoch 5 with different roots as a matter of course — not adversarially,
just by both having committed five times. The identity that distinguishes them is on chain, is in the
payload, and is dropped at this module's boundary.

### What it costs — measured, not asserted

`scripts/sim/multi-committer-freshness.ts`, deterministic (LCG, no `Math.random`), 500 presentations
per row. **Every presentation is honest and maximally fresh: the agent's own current epoch, its own
real root, nothing withheld.** The only variable is whether the stream was filtered to that agent.

| seed | agents | maxEpochLag | refused (unfiltered) | refused (filtered) | reasons |
|---|---|---|---|---|---|
| 1 | 2 | 0 / 1 / 3 | **100.0%** | **0.0%** | equivocation 100% |
| 1 | 12 | 0 / 1 / 3 | **100.0%** | **0.0%** | equivocation 100%, stale 80.4% |
| 2 | 2 | 0 / 1 / 3 | **100.0%** | **0.0%** | equivocation 100%, stale 55.2% |
| 2 | 12 | 0 / 1 / 3 | **100.0%** | **0.0%** | equivocation 100%, stale 76.6% |
| 3 | 2 | 0 / 1 / 3 | **100.0%** | **0.0%** | equivocation 100%, stale 48.6% |
| 3 | 12 | 0 / 1 / 3 | **100.0%** | **0.0%** | equivocation 100%, stale 82.8% |

Three things follow, and the third is the one that matters most:

1. **Two agents are already enough.** This is not a scale effect that appears at fleet size; it is
   present at the smallest multi-agent deployment, and this repo runs twelve.
2. **The lag bound is inoperative.** #260's central measurement is the cost of the `maxEpochLag`
   dial, derived with care over three seeds. On an unfiltered stream the dial changes nothing —
   `epoch-equivocation` refuses unconditionally, before lag is ever weighed. The bound was measured
   on a workload that assumed the precondition this finding is about.
3. **The verdict does not merely refuse — it accuses.** 100% of these refusals carry
   `epoch-equivocation`, which the module documents as strictly stronger evidence than lag: "a
   lagging publication is explicable by latency, an equivocating committer is not." An honest
   committer is handed the one verdict the design says an honest committer cannot produce.

### What this is NOT

**It is not a soundness break, and the direction matters.** The failure is toward refusal in every
case; nothing forged is accepted. A withheld epoch is still caught when the stream is correctly
scoped (pinned as a test). This is a false-abstention result — the same shape #258 measured for
`LIVE_ROOT` (sound, and unusable) and #260 measured for `maxEpochLag = 0`, arriving from a third
direction: **a module can be correct, verified, mutation-graded, and still refuse everything, because
the precondition that makes its inputs comparable was never written down.**

### The fix is a field, not a redesign

The filtered column is `0.0%` in every configuration — the precondition is not merely satisfiable,
it is free. Two changes:

1. `AnchorObservation` gains a `committer` (the `agentId` the anchor already carries), and both
   comparisons scope to it — `latestKnownEpoch` per committer, `rootByEpoch` keyed by
   `(committer, epoch)`.
2. Until then, the module's header should state the precondition it currently assumes: *the stream
   must already be filtered to the committer whose publication is presented.* An unstated
   precondition is what turns a correct module into a broken feature.

`tests/multi-committer-freshness.test.ts` pins both directions and says in its own header that the
"unfiltered" expectations are the ones a committer-scoped fix must flip.

## 3. Second finding, unrelated surface: `shadow_reject` collapses two different failures [V sql]

Beats 54–57 read `shadow_reject` as "fabrication caught". Today's queue says that reading is not
sound:

| task | length | content | `artifact_url` | status |
|---|---|---|---|---|
| #435039 | 15,099 | real epoch-schema decision table | set | `done` |
| #435041 | 185 | pure meta-assertion, no artifact | set | `shadow_reject` |
| **#435040** | **12,309** | **real anchor cost model, 7 sections, explicit "Honest UNKNOWN"** | **NULL** | **`shadow_reject`** |

#435040 is Beat 57's dispatch, and it delivered: a symbolic cost model, fixed-overhead-vs-calldata
dominance, the cadence floor, four non-gas costs, three policies each with its counter-argument, a
ranked recommendation, and a closing section naming the two inputs it genuinely does not know. It is
the best of the three, it answers exactly the question Beat 57 said the simulation could not, and it
was discarded with the same status as a 185-character assertion.

The observable pattern is [V]; the mechanism is **[R]** — the gate lives agent-side
(`trinity-symphony-shared`), not in this repo, so I did not read its code. What the rows support is
that a **missing artifact row** and a **fabricated deliverable** produce the same status, and the
answer survives in `trinity_tasks.result` where nothing reads it.

**Same shape as §2, one surface over:** a distinguishing field is absent, so two things that are not
alike receive one verdict.

---

## Reproduce

```bash
npx ts-node --transpile-only scripts/sim/multi-committer-freshness.ts
npx jest --config jest.config.js --runInBand tests/epoch-freshness.test.ts tests/multi-committer-freshness.test.ts
```

39/39 (32 from #260, unchanged, + 7 here). Targeted `tsc --strict --noUncheckedIndexedAccess` clean.
