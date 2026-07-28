# Beat 58 — the winning policy was scored against a snapshot fresher than the artifact it graded; and the freshness dial is a step, not a slope

**Date:** 2026-07-28 · **Repo:** `repid-engine` · **Artifacts:** `src/memory/epoch-freshness.ts`, `tests/epoch-freshness.test.ts`
**Verified this beat:** repid-engine **#258** (Beat 57's trusted-root simulation) — not authored by this run.

---

## 1. Verification of #258 — every figure reproduces exactly [V]

Re-ran the simulation from the PR head (`a3a0a08`) in isolation, seeds 1/2/3, `ops=20000`:

| claim in the report | recomputed | verdict |
|---|---|---|
| LIVE_ROOT false-abstains 99.7–99.8% | 99.8 / 99.7 / 99.8 % | ✅ |
| LIVE_ROOT unsound-accept exactly 0 | 0 / 0 / 0 | ✅ |
| ANCHORED_LIVE_EMIT >95% | 97.8 / 97.4 / 97.7 % | ✅ |
| ANCHORED_EPOCH_EMIT unciteable 1.1% | 1.1 / 1.1 / 1.1 % | ✅ |
| unciteable monotone in cadence, every step | 0.2→0.7→1.1→1.9→4.5 (s1) and likewise s2/s3 | ✅ |
| unsound-accept rests on 9–17 events | 9 / 17 / 12 retractions-before-verification | ✅ |

**The artifact recomputes its own claims.** After Beat 54 refuted #251 for the opposite reason, that is worth stating plainly rather than assuming.

The report is also honest where it could have flattered itself: it flags `RE_DERIVE`'s 0/0 as a tautology, declines to quote unsound-accept decimals, and states `ANCHORED_EPOCH_EMIT`'s zero as holding "by construction."

## 2. [X] The finding: the winning policy is scored with a snapshot fresher than the witness it grades

`simulate()` decides `citedFromEpoch` against the **emit-time** anchor set, then grades acceptance against `anchoredLive` **read at verify time** — which may be one or more epochs newer. The name "trust *and emit at* the last anchored root" admits two readings, and the code implements neither: it takes the citeability test from one and the correctness test from the other.

Disambiguated over the same workload, same seeds:

| reading | false-abstain (s1/s2/s3) | unsound-accept |
|---|---|---|
| **AS_SHIPPED** — verify-time snapshot | 0.00 / 0.00 / 0.00 % | 0.14 / 0.10 / 0.23 % (n=7/5/11) |
| **EMIT_EPOCH** — the snapshot the witness was built against | 0.00 / 0.00 / 0.00 % | 0.16 / 0.29 / 0.23 % (n=8/14/11) |
| **LATEST_ONLY** — verifier requires the newest anchor | **79.81 / 78.83 / 80.26 %** | 0.04 / 0.06 / 0.10 % |

Two consequences.

**(a) The unsound-accept column is an under-estimate.** Grading a witness against a snapshot newer than the witness can only flatter it; on seed 2 the honest reading is ~3× higher. The magnitudes are single-digit event counts and are not quotable — the *direction* is the finding, and it is structural, not sampling.

**(b) The 0% is not robust to the integration choice.** **~80% of answers are verified in a later epoch than they were emitted against** (79.9 / 79.1 / 80.4 %) — the dominant case, not a corner. If production reads "the trusted root is the last EAS-anchored root" as *the newest anchor the verifier holds* — the most natural reading of the question #242 posed — the policy costs ~79–80% false abstention, not 0%.

So #258's operational conclusion needs one more clause than it carries. It is right that pointing `current_memory_root` at the last **committed** root is a switch that turns grounding off. It is not yet enough to say "use the anchored root": **the usable policy is "trust the anchored root the ANSWER NAMES, bounded by how old that anchor may be."** The bound is not optional — it is the entire remaining cost.

## 3. The bound is a step, not a slope

An answer can lag by at most `ceil(verification latency / epoch period)` epochs, so the dial was swept against that structural maximum:

| verification latency (epoch period 50) | structural max lag | `maxEpochLag=0` | `=1` | `=2` | `=3` | `≥ max` |
|---|---|---|---|---|---|---|
| 40 ops | 1 | ~79–80% | **0.00%** | 0.00% | 0.00% | 0.00% |
| 120 ops | 3 | ~99% | ~99% | ~40% | **0.00%** | 0.00% |
| 200 ops | 4 | ~99% | ~99% | ~98% | ~98% | **0.00%** |

**Any bound at or above the structural maximum costs exactly nothing; one epoch below it costs 40–99%.** There is no graceful degradation and nothing to tune: the bound is *derived*, `maxEpochLag = ceil(max verification latency / epoch period)`. Choosing it by feel lands on "free" or on "broken" with almost no ground between. (At the default parameters the maximum is 1, which is why `LAG_1` through `LAG_5` are byte-identical there — the dial is saturated, and a sweep at those parameters alone would have shown a flat line and taught nothing.)

## 4. The advance — `epoch-freshness.ts`, the withheld-epoch check

`memory-publication.ts` names its own blind spot: *"It does not establish that the anchored epoch is the LATEST epoch… Detecting a withheld later epoch needs the anchor STREAM, not a single anchor."* This module is that check, and §3 supplies its one parameter.

- `checkEpochFreshness(presented, observations, policy)` — pure, total, terminating. Refuses `stale-epoch` when the presented epoch lags the newest observed one past the bound.
- **`epoch-equivocation`** — two roots asserted for one epoch, from any pair of sources *including the presentation itself*. Strictly stronger evidence than lag: a lagging publication is explicable by latency, an equivocating committer is not.
- **`derivedMaxEpochLag(latency, period)`** — the bound §3 says to use, returning the strict `0` on any degenerate input rather than an open one.
- **Fail-closed with the honest boundary stated:** a verifier holding no observation cannot detect withholding, and the module says so (`no-usable-observation`) instead of passing. The attack is not closed; it is converted from undetectable into a **stated, checkable precondition**. Detection is monotone in observers — a withholder is refused by anyone who has seen a later epoch.
- **`requireObservation: false`** moves the **verdict**, not just the reason list (see §6).
- **Noise cannot refuse.** Malformed observations are skipped and counted, deliberately *not* verdict-bearing — a deliberate exception to this family's fail-closed default, because otherwise anyone who can write to the feed could refuse any agent at will. Fail-closed survives through the *absence of evidence* (`no-usable-observation`), not the presence of noise.
- **Stated non-claim:** the feed is trusted for what it asserts. A hostile feed can fabricate a later epoch and refuse an honest committer — a DoS against the committer, not a soundness break, and the reason every verdict carries the `source` that decided it.

**Zero coupling to the open stack.** One new source file, one new test file, a single type-only import of `Hex`. No edit to `leanimt-plus.ts`, `hal-grounding.ts`, or anything #242/#243/#245/#255/#258 touches.

## 5. Mutation battery — graded by which test dies

| mutant | tests killed | which |
|---|---|---|
| A — `stale-epoch` clause deleted | 3 | `WITHHOLDING`, `LAG BOUND IS EXACT`, `MISSING POLICY IS THE STRICT ONE` |
| B — equivocation detection removed | 2 | both `EQUIVOCATION` cases |
| C — `requireObservation` not verdict-bearing | 1 | `OPT-OUT MOVES THE VERDICT` |
| E — malformed observation forces refusal | 1 | `NOISE CANNOT REFUSE` |
| F — cap checked after the scan | 1 | `BOUNDED BEFORE THE SCAN` |
| G — root comparison case-sensitive | 1 | `CASE-INSENSITIVE ROOTS` |
| H — outer boundary removed | 1 | `TOTAL` |
| **D1 — explicit `epochOk` term removed** | **0** | **survives** |
| **D2 — trailing `reasons.length === 0` removed** | **0** | **survives** |
| D4 — `epochLag` computed unconditionally *and* `epochOk` dropped | 6 | all `EPOCH IS A TIME` cases |

Source restored from a byte-compared golden after every mutant (`cmp -s` clean; final `source == golden` asserted).

## 6. [X] What the battery corrected in my own work

**The named guard was not the guard.** The module's header claimed the epoch clause is "a TERM of `ok` in its own right" — the Beat-56 defect explicitly not repeated. **Deleting that term kills no test.** What actually refuses a malformed epoch is `epochLag`, computed as `null` when the epoch is unusable, so `epochLag !== null` does the work; only removing *both* (D4) kills the six `EPOCH IS A TIME` cases. The code is fine; the **description overstated which clause was load-bearing** — one beat after the finding that a clause computed-and-not-read is the defect. The comment now says what the battery measured.

**`reasons.length === 0` kills no mutant (D2)** — exactly as its counterpart does in `memory-publication.ts`. Reported as fail-closed future-proofing that the battery does not validate. Not claimed as validated.

**Caught before the PR by writing the test that names the property:** the first draft's `requireObservation: false` changed only whether a reason was *emitted*, never the verdict — the option would have been decorative. Mutant C now pins it.

**A fixture that indicts itself.** The first `BOUNDED BEFORE THE SCAN` test built an oversized "array" with `Object.setPrototypeOf`, which `Array.isArray` ignores — so it hit the `observations-not-an-array` clause and graded nothing about the cap. Rewritten to a real oversized array **filled with valid observations that would make the publication fresh**, so refusal is now evidence the cap fired ahead of the loop, plus a one-below-the-cap case proving the test is not vacuous.

**A process failure worth recording:** the first battery run died on a `cp1252` decode of jest's output *after* writing mutant A, leaving the working tree mutated. Restored from the golden and re-run with binary-safe decoding. **A battery harness must restore in a `finally`, not on the happy path** — an interrupted battery is indistinguishable from a passing one if nobody checks the tree.

## 7. Local verification (bounded, per the contract)

- `tsc --noEmit --strict --noUncheckedIndexedAccess` clean on both new files.
- `tests/epoch-freshness.test.ts` **32/32**; with `tests/leanimt-plus-commitment-audit.test.ts` **73/73** (the audit suite's 41 unchanged — the baseline count asserted, not just the colour).
- No repo-wide build or suite run locally; CI is the authority.

---

**Shape of this beat:** *a measurement scored against fresher evidence than the thing it measures.* Beat 55 found a field written and never read; Beat 56 found a clause computed and never read; this one is a grading snapshot that is newer than the artifact being graded — the error is invisible in the verdict and shows up only as a number that is too good.
