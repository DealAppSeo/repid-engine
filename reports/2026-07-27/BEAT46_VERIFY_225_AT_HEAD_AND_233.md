# Beat 46 — Independent verification of repid-engine #225 (at head) and #233

**Verifier:** independent, no authorship of either PR. Worked in an isolated clone under
the scratchpad (`.../scratchpad/verify225-233/repo`), never touched the shared working
tree at `C:\Users\Cash4\repos\repid-engine`. Only artifact written into that repo is this
file.

**Branches verified (fetched from the local `origin` remote, which is the working repo):**
- `#225` = `feat/cc-2026-07-27-proof-tier-policy` @ `4eda14b` (this now includes the
  merged `#228` regret-disclosure commit -- confirmed by `git log`, matches the task's
  description that #225's head is `4eda14b`).
- `#233` = `feat/cc-2026-07-27-proof-tier-regret-pins` @ `e41bf80`, based on #225's branch.

**Method and its limits (disclosed up front):** targeted mutation testing against the
specific claims named in the task, plus reading. I did not run an exhaustive/automated
mutation framework (none is wired into this repo) -- every mutation below is a manual
source edit, landing confirmed by `git diff` before judging, source restored by
`git checkout --` after. This is the same manual-mutation method the loop itself has been
using; it finds what it is pointed at and nothing else. I did not mutation-test
`anfis-comma.ts` (the shared fabric #225 reuses) or every line of `proof-tier-corpus.ts`'s
30 scenarios individually -- that would be a much larger effort than an 8-beat pattern
check warrants. I did not re-run the full 2,518-test repo-wide suite on either branch
(the reports' claim of "3 failing suites, live-Supabase ECONNREFUSED" was not re-verified
by me); I scoped to the touched files, which is what the task asked for.

---

## 0. Baselines (unmodified, both branches)

| branch | files | suites | tests | result |
|---|---|---|---|---|
| #225 @ `4eda14b` | `proof-tier-policy.test.ts` + `proof-tier-regret.test.ts` + `proof-carrying-memory.test.ts` | 3 | 55 | **green** [V] |
| #233 @ `e41bf80` | same 3 files, run separately (combined run hit the 3-minute tool timeout, not a suite issue -- the 32,768-point sweeps in `proof-tier-policy.test.ts` alone take ~215-260s) | 3 | 70 (22 + 12 + 36) | **green** [V] |

Per-file counts, all green: `proof-tier-policy.test.ts` 22/22 (both branches, unchanged by
#233), `proof-carrying-memory.test.ts` 12/12 (both branches, unchanged by #233),
`proof-tier-regret.test.ts` 21/21 on #225, then 36/36 on #233 (#233 adds 15 new tests: the
regret-column literals, the same-quantity check, the ranking-reversal check, the
null-crossover check, the step-function synthetic test, and the 4-test robustness-sweep
block). All counts match the numbers quoted in `reports/2026-07-27/BEAT43_PROOF_TIER_REGRET.md`
and `BEAT45_REGRET_PINS_AND_REAPER_TRIGGERS.md` -- no discrepancy found. `npx tsc --noEmit`
exit 0 on #233 (a strict superset of #225's touched files). Both baselines are green, so
mutation scores below are meaningful (per the task's own caveat).

---

## 1. #225 AT HEAD -- the unverified delta, and what it still ships

**What "at head" adds beyond the last confirmed verification.** `git log` on the branch:

```
4eda14b feat(anfis): measured regret ... (#228)              <- UNVERIFIED delta, part 2
56d6a9d test(anfis): pin the SAFETY floors to literals ...    <- UNVERIFIED delta, part 1
a439d56 test(anfis): pin the ANFIS fabric ... (independent verification of #225)
4621bde feat(anfis): proof-tier selection as a first-class policy output (original #225)
```

`56d6a9d`'s own commit message states "An independent verifier (no authorship of #225)
confirmed..." -- that is the "earlier verification" the task refers to, and it covered
`4621bde` + `a439d56` only. `56d6a9d` (the fix for what that verifier found) and `4eda14b`
(`#228`, merged into this branch afterward) are the delta nobody had re-verified until now.

### 1a. `56d6a9d` (safety-floor literals) -- HIGH-severity pattern, now closed. Re-confirmed by mutation.

- **Mutation:** `RELIABILITY_FLOOR = 0.8` changed to `0.85` in `src/services/proof-tier-policy.ts`.
  Landed (confirmed by `git diff`). Ran `proof-tier-policy.test.ts` (22 tests, about 221s).
  **Result: 1/22 FAILED** -- `the SAFETY floors are pinned to literals...` at
  `tests/proof-tier-policy.test.ts:358` (`expect(RELIABILITY_FLOOR).toBe(0.8)`). Killed.
- This is the exact defect class named in the task brief (weaker-property-than-claimed):
  before `56d6a9d`, this constant could drift with the whole suite green because the old
  test fed the constant into itself. The fix is real and I reproduced it independently
  rather than trusting the commit message.

### 1b. `4eda14b` / `#228` (regret disclosure) -- HIGH-severity gap, STILL PRESENT at #225's head.

The task's own framing ("the CLAIM test recomputed regret from a private lambda instead
of reading the column it cites") is exactly what is in the code at #225's head. I read the
CLAIM test at #225 head before mutating:

```
// tests/proof-tier-regret.test.ts, #225 @ 4eda14b, "is the strict regret minimiser..."
const P = 100;
const regret = (r) => r.overProofCostUnits + P * r.underProof;   // private lambda, does
const mine = regret(policy);                                     // not read regretAtPrice
for (const r of results) { if (r.name === 'policy') continue;
  expect(regret(r)).toBeGreaterThan(mine); }
```

This never reads `r.regretAtPrice` -- the field that is printed by the CLI
(`scripts/measure/proof-tier-regret.ts`) and quoted in `BEAT43_PROOF_TIER_REGRET.md` as
"the number worth filing." Two mutations to `src/services/proof-tier-regret.ts`'s
`scoreStrategy` (the function that actually computes the published `regretAtPrice`
column), each landed-confirmed by `git diff`, each run against `proof-tier-regret.test.ts`
(21 tests) at #225's head:

| mutation | edit | result on #225 @ 4eda14b |
|---|---|---|
| sign flip | `overProofCostUnits + p * underProof` to `overProofCostUnits - p * underProof` | 21/21 green -- SURVIVED |
| penalty deleted | `overProofCostUnits + p * underProof` to `overProofCostUnits` | 21/21 green -- SURVIVED |

Both confirmed, source restored after each, re-ran clean (21/21) to confirm restoration.
This means #225 at head, standing alone, ships a Patent #2 enabling-disclosure number
(`regretAtPrice`, and by extension the printed "R@10/R@40/R@200" columns and the whole
"operating band" framing built on it) that is pinned by nothing. A future edit could
silently invert or delete the safety-relevant term in the regret formula and #225's own
suite would not notice.

**Verdict on #225 at head:** the properties layer (`proof-tier-policy.test.ts`) is now
solid -- P1 through P7, the golden-literal ANFIS-fabric-is-load-bearing check (see section
3 below), and the safety-floor literals all hold up under mutation. But #225's head is not
just the properties layer; it is `4621bde` + `a439d56` + `56d6a9d` + `4eda14b`, and that
last commit ships the exact class of hole this beat-family exists to catch, unfixed.
**#225 AT HEAD: SEND BACK** -- not for the policy code, which is sound, but because the
regret-disclosure module it now carries (via the merged #228) is unpinned in the way
described above. Concretely: do not let #225 land on `main` on its own with this gap live,
even briefly, given this module is enabling-disclosure material for a pending patent
filing. #233 (below) is the fix and is stacked directly on top of #225's branch -- the two
should land together (or #233 immediately, same beat, with no intervening state where
`main` carries the unpinned version).

---

## 2. #233 -- verifying its four claimed fixes

### 2a. CLAIM test now reads the published column -- VERIFIED FIXED.

Re-ran the identical two mutations from section 1b against #233's `proof-tier-regret.ts`
(now `e41bf80`'s copy) and #233's `proof-tier-regret.test.ts` (36 tests):

| mutation | result on #233 @ e41bf80 |
|---|---|
| sign flip | 8/36 FAILED -- killed (`is the strict regret minimiser at a PUBLISHED price...`, `the regret column is the SAME quantity...`, `...reverse the ranking...`, plus 5 more) |
| penalty deleted | 8/36 FAILED -- killed, same 8 tests |

Both counts match the beat's own report ("8 tests fail") exactly, independently
reproduced rather than trusted. The new CLAIM test (`is the strict regret minimiser at a
PUBLISHED price...`) does read `policy.regretAtPrice[P]` directly, and a companion test
(`the regret column is the SAME quantity the band is derived from, at every price`)
independently recomputes `overProofCostUnits + p * underProof` from the two components
(each separately pinned as literals in the `it.each` table) and checks it equals the
published column -- closing the gap between "the number I compute" and "the number that
ships." VERIFIED.

### 2b. `~661` conditionality -- VERIFIED, pinned two ways.

Two independent checks, both real:

- **Synthetic unit test** (`DISCLOSED LIMITATION: the upper edge is a STEP FUNCTION...`):
  constructs `StrategyResult` objects with `underProof` 1/2/0 and asserts
  `operatingBand(...).upper` is `661.0` / `330.5` / `Infinity` respectively. This tests the
  mathematical dependency directly and is present at baseline (passed in the 36/36 green
  run).
- **Real-corpus, real-route mutation (mine, not in either PR):** lowered
  `TIER_THRESHOLDS`'s top boundary in `src/services/proof-tier-policy.ts` from `0.82` to
  `0.75` -- a genuine change to the routing logic, confirmed via
  `npx tsx scripts/measure/proof-tier-regret.ts` to flip `best-provider-route` from
  under-proved to exact and take `policy.underProof` from 1 to 0 (upper edge goes to
  infinity, printed by the CLI itself). Ran `proof-tier-regret.test.ts` on both branches:
  - #233: 10/36 FAILED, including the direct literal `expect(policy.underProof).toBe(1)`
    added by #233 inside the "operating band is non-empty" test -- the assertion that
    would force anyone who fixes `best-provider-route` to revisit the ~661 figure.
  - #225 (pre-#233): 4/21 FAILED -- also caught, but only incidentally, through the
    pre-existing `it.each` literal table (`policy: exact=14 under=1 over=15 ...`) that
    #228 already shipped. So this specific dependency was already weakly protected on
    #225; #233 makes the tie explicit and local to the claim it supports rather than
    relying on a distant table. Not a hole #233 closes so much as a claim #233 correctly
    makes explicit and testable in its own right -- both true, worth noting the nuance.

VERIFIED, with the above nuance recorded rather than smoothed over.

### 2c. The 28/30 second-labeller caveat -- NOT asserted. Prose only. Real finding.

The task asks specifically whether this is "asserted rather than merely written in
prose." I searched #233's diff and the whole repo history (`git grep` and
`git log --all --diff-filter=A --name-only`, across all branches) for any artifact
backing the "28/30" figure -- a data file with the second labeller's 30 labels, a
fixture, a snapshot, anything:

```
git grep -n "28/30|second labell|second-labell" origin/feat/cc-2026-07-27-proof-tier-regret-pins -- . ':!node_modules'
-> only 4 hits, all in comments (src/services/proof-tier-corpus.ts:15/17/25,
  tests/proof-tier-regret.test.ts:375/376/384/435)
```

**Enumerated and not found:** no `.json`/`.csv`/`.ts` data file with the second
labeller's actual 30 requiredTier values; no test that computes an agreement count and
asserts it equals 28 (or >=28, or any number); no commit that adds such a file (checked
`git log --all --diff-filter=A --name-only | grep -i "corpus\|label"` -- the only hits
are an unrelated HAL ground-truth-labels feature from May, not this corpus). **Searched:**
all branches' history via `git log --all`, the corpus file, the test file, the report
markdown. **Not searched:** any file outside the git repo (e.g. a local-only transcript of
the labelling session, if one exists on the machine that ran Beat 44) -- I have no way to
reach that from this repo clone, and the report itself does not reference such a file.

What #233 does assert is the caveat about the caveat: `LIMIT OF THIS METHOD, stated
rather than hidden` checks that the corpus is grouped in contiguous tier blocks
(`blocks < order.length`), which is the "28/30 is a lower bound, not a measurement"
disclosure. That one sub-claim is real and tested. But the headline number itself --
28/30, and the claim that "both disagreements landed on scenarios whose own why
pre-registered the call" -- is asserted nowhere in code, and no committed artifact lets a
third party (or me) recompute it. It rests entirely on trust in an unlogged prior session.
Given the standing pattern this whole beat-family exists to catch (published numbers with
nothing pinning them) and given this is explicitly enabling-disclosure material for a
patent filing, this is the same shape of gap, one level up: the `regretAtPrice` column was
unpinned code; the 28/30 figure is an unpinned fact.

**Severity: MEDIUM-HIGH.** It does not corrupt any test or make the shipped test suite
lie about the code -- the STRUCTURAL/CLAIM/DISCLOSED tests all still hold on their own
terms. But the disclosure prose currently states a specific, quotable number ("28/30
agreement... both disagreements landed on scenarios whose own why had already flagged the
call") as established fact, and nothing in the repository can currently falsify or
reproduce it. **Recommend before this is cited externally/in a filing:** either (a) commit
the second labeller's actual 30-row label set as a data file with a test that recomputes
the agreement count from it and asserts it equals 28, or (b) rewrite the prose to state
plainly that the 28/30 figure is reported from an external session and is not
independently verifiable from the repository as it stands.

### 2d. 120-relabelling sweep -- VERIFIED, independently reproduced, exact match.

Wrote a standalone script (outside the test file, using the shipped `operatingBand` +
`runRegretMeasurement` + `PROOF_TIER_CORPUS`) that performs the identical sweep -- every
scenario perturbed to every other rung, one at a time, 30 x 4 = 120 combinations -- and
prints the aggregate statistics independently of the jest assertions:

```
n= 120
empty= 0
unbounded= 4
ceiling cut >=25% = 44
lower min= 28.5 max= 50.333333333333336 median= 37.857142857142854
265/7= 37.857142857142854
```

Exact match to the published figures (n=120, empty bands=0, unbounded=4, ceiling cut
>=25%=44, lower edge min 28.5 / median 37.857... / max 50.333, unperturbed value 265/7 =
37.857142857142854 = the exact median). This is not a re-run of the jest test (which
would only confirm the assertions are internally consistent); it is a second, independent
implementation reading the same production code, computed and compared by me. The claim
that "the corpus sits at the exact median of its own sensitivity range" is VERIFIED, not
merely passed.

---

## 3. Extra scrutiny on #225's keystone claim (task step 3)

Beyond the CLAIM gap in section 1b, I spot-checked whether the "unified learned fabric"
claim (the `P2b` golden-literal test) is as tightly pinned as it looks, since
exact-literal matches can themselves be shallow if the literals are loose:

- **Mutation:** `RULE_PARAMS[0][0]` (`1.20` to `1.25`, a roughly 4% coefficient drift) in
  `src/services/proof-tier-policy.ts`. Landed (confirmed by diff). Ran
  `proof-tier-policy.test.ts`: 1/22 FAILED -- `P2b: the decisions come from the ANFIS
  fabric...`, on the `confidence` field specifically ("low-everything:0.8941" expected,
  "low-everything:0.9015" received). Killed -- the golden-literal test is sensitive to a
  small coefficient drift, not just to gross replacement of the fabric. This is the right
  shape of test (exact match on a derived, non-trivial float) and it held up.
- I did not find a way to perturb the tier ordering (`PROOF_TIERS` array) or the policy
  output more broadly while keeping #225's suite green, within the time available -- the
  existing P1 (reachability), P3 (floor safety, independent oracle), P4/P5 (monotonicity,
  exhaustive sweep over 8^5 = 32,768 points), and P6 (cost/latency strictly increasing)
  tests cover that surface densely and I did not find a gap in it. This is a negative
  result under my method's limits (stated above), not a proof of absence.

---

## 4. Disclosure-accuracy sanity check (task step 5)

- "The corpus imports nothing" -- verified directly (`git grep -n "^import\|require("
  src/services/proof-tier-corpus.ts` returns no hits, both branches).
- "Committed before the runner existed" -- #233 itself demotes this from the corpus
  header's earlier framing ("the weakest, and previously overstated in this header...
  Kept as a fact, demoted as an argument") -- this is #233 correcting its own
  predecessor's overstatement, which is the right instinct and is itself verifiable by
  reading the diff, not a new claim needing separate verification.
- `TIER_COST_UNITS` as "stipulated, not measured" -- this caveat is stated in
  `BEAT43_PROOF_TIER_REGRET.md` (section 7) but I did not find equivalent language in the
  in-repo code comments of `proof-tier-regret.ts` or the CLI script. Not a false claim --
  just a caveat that lives in the report and not in the shipped disclosure surface. Minor;
  worth folding into the code comment if this module's own header is what eventually gets
  quoted in a filing rather than the beat report.
- The CLI's own printed "operating band" section (added by #233) states the conditional
  upper-edge caveat in the same words as the code comment and the test -- consistent, no
  overstatement found there.

---

## Findings summary

| # | Finding | Severity | Branch | Evidence |
|---|---|---|---|---|
| 1 | `regretAtPrice` unpinned at #225 head -- sign-flip and term-deletion both survive 21/21 green | HIGH | #225 (at head, i.e. including merged #228) | section 1b, 2 mutations, both SURVIVED |
| 2 | Same defect, confirmed FIXED on #233 | -- (resolved) | #233 | section 2a, same 2 mutations, both KILLED (8/36 each) |
| 3 | Safety-floor literal drift (`RELIABILITY_FLOOR`) -- confirmed fixed by 56d6a9d, still holds at #225 head | -- (resolved, re-confirmed) | #225 | section 1a, 1/22 killed |
| 4 | `~661` upper-edge conditionality -- pinned on #233 via synthetic test + direct `underProof===1` literal; also incidentally caught on #225 via a pre-existing literal table | LOW (clarifying, not a new hole) | both | section 2b, real route mutation, 10/36 failed on #233, 4/21 on #225 |
| 5 | 28/30 second-labeller headline figure has no corroborating artifact in the repository -- only the corpus-grouping lower-bound caveat is asserted; the number itself is prose-only and unreproducible from anything committed | MEDIUM-HIGH | #233 | section 2c, enumerated search across all branches, no data file found |
| 6 | 120-relabelling sweep numbers -- independently reproduced, exact match | -- (verified true) | #233 | section 2d, standalone script, byte-identical output |
| 7 | ANFIS-fabric golden-literal test sensitive to small coefficient drift | -- (verified robust) | #225/#233 (shared file) | section 3, 1/22 killed on a 4% drift |

---

## Verdicts

**#225 (`feat/cc-2026-07-27-proof-tier-policy` @ `4eda14b`): SEND BACK.**
The properties layer (`proof-tier-policy.test.ts`) is solid and I could not break it
within the time available. But #225's head is not just that file -- it includes the
merged `#228` regret-disclosure module, and that module's central published number
(`regretAtPrice`, and the "operating band" claim built on it) is pinned by nothing at
#225's head: two one-line mutations (sign flip, term deletion) both survive its entire
suite. This is the exact defect class this beat-family exists to catch, and it is
present, not hypothetical. **What must change:** land #233 together with #225 (or
immediately after, same beat, with no window where `main` carries the unpinned version)
-- #233 is already the correct, verified fix for this exact gap.

**#233 (`feat/cc-2026-07-27-proof-tier-regret-pins` @ `e41bf80`): SEND BACK, narrowly.**
Three of its four claimed fixes are independently verified and solid: the CLAIM-test
recomputation fix (2a), the `~661` conditionality pin (2b), and the 120-relabelling sweep
(2d -- exact independent reproduction). The fourth -- the corpus-provenance argument's
"strongest defence," the 28/30 second-labeller result -- is not actually asserted by any
test and has no supporting artifact anywhere in the repository's history; only a
narrower caveat about the labeller's method is asserted. Given this PR is explicitly
enabling-disclosure material for a pending patent filing, and given the standing pattern
this whole loop is designed to prevent is exactly "a number that ships without anything
pinning it," this should be closed before the disclosure is relied on externally.
**What must change:** either commit the second labeller's actual 30 labels as a data
file with a test that recomputes and asserts the 28/30 agreement count, or rewrite the
provenance section to state plainly that the number is reported from an external session
and is not independently reproducible from the repository as it stands. Everything else
in #233 is ready as-is.

---

## What I could NOT verify, and why

- The claim that "the three failing suites in the full 2,518-test run are live-Supabase
  (ECONNREFUSED)" -- not re-run; I scoped to the three touched test files per the task,
  and a full-repo run was outside the time budget for this pass.
- Whether the second labeller's session actually produced 28/30 and the stated rationale
  for the two disagreements -- I have no channel to that data from this repo clone; I can
  only confirm (and did confirm, section 2c) that nothing in the repository lets a third
  party verify it. That absence is the finding, not a gap in my method.
- Full mutation coverage of `anfis-comma.ts` (the shared fabric) and of each of the 30
  corpus scenarios individually -- out of scope for the time available; flagged as a
  method limitation, not asserted as clean.
- I did not attempt to break `PROOF_TIERS` ordering or the policy output more broadly
  beyond the coefficient-drift and threshold mutations above -- negative result under
  time constraints, not a proof the surface is unbreakable.
