# Two-day engineering report — 2026-08-03 / 2026-08-04

**Author:** REPORT lane · **Date:** 2026-08-04
**Window:** pull requests merged or opened between `2026-08-03T00:00Z` and `2026-08-05T00:00Z`.
All timestamps in this report are **UTC**, because that is what the GitHub API returns. The
repository's local timezone is PDT (UTC−7), so a commit stamped `2026-08-03T20:44-07:00` in
`git log` appears here as `2026-08-04T03:44Z`. Several apparent date disagreements between this
report and a `git log` transcript are that offset and nothing else.

**Evidence tags:** `[V]` verified by a command whose output is cited · `[R]` reported by a PR body
or another lane and not independently re-run here · `unknown` where the evidence does not decide.

> This repository is **public**. This report deliberately states findings rather than inventories:
> no project identifiers, no key material, no wallet addresses, no exhaustive row-count dumps.
> Counts appear only where the count *is* the finding.

---

## 1. Objective

The sprint ran four to eight concurrent agent lanes against one repository, each fenced to a
subtree, with three standing goals:

1. **Make the reputation ledger honest.** The scoring path had a documented clamp that the live
   code did not apply, an audit table whose rows did not reconcile, and eleven-plus writers
   sharing an undocumented database trigger contract.
2. **Make measurements comparable.** HAL's F1 has been quoted at 0.34, 0.74, 0.886 and 0.890.
   Those are four rulers, not a trend, so *"did HAL improve?"* had no answer.
3. **Make parallel agents safe to run unattended.** Prior sprints lost work to two lanes editing
   one file, and to reports containing numbers the reporting agent could not have obtained.

A fourth objective emerged mid-window and displaced part of the third: the repository is **public**
and every agent in the fleet believed it was private, because `CLAUDE.md` said so.

---

## 2. Method

### 2.1 What was run

```
gh pr list --repo DealAppSeo/repid-engine --state all --limit 60 \
   --json number,title,state,mergedAt,headRefName,createdAt
git log origin/main --since=2026-08-02T20:00 --format="%h|%ad|%s" --date=iso-strict
gh pr view <n> --repo DealAppSeo/repid-engine --json body --jq .body      # for every PR in range
```

Reconstruction is from pull-request bodies and the commit graph, not from any lane's summary. Where
a PR body makes a claim this report repeats, it is tagged `[R]` unless re-verified here.

### 2.2 The lane / fence system, as it actually operated

Three mechanisms, two of them enforced by the harness rather than by instruction.

| mechanism | file | enforcement |
|---|---|---|
| capability fence | `src/orchestration/lane-registry.ts` | library — a dispatcher must call `canAssign()` |
| output-contents gate | `src/orchestration/handoff-gate.ts` | library — a reviewer must call `evaluateHandoff()` |
| write-lease fence | `src/orchestration/write-lease.ts` + `scripts/hooks/lane-write-guard.js` | **`PreToolUse` hook** on `Edit\|Write\|NotebookEdit` |
| publication guard | `scripts/hooks/publication-guard.js` | **`PreToolUse` hook** on `Bash` |

Both hooks are registered in `.claude/settings.json` `[V]`, so they run outside the model's control.
The two libraries are not.

The **capability fence** types lanes by *access*, not skill — `http`, `db_read`, `db_write`,
`repo_write`, `merge`, `chain_read`, `chain_send`, `infra`, `reasoning` — and refuses an assignment
whose required capabilities the lane lacks. Its stated origin is a measurement: the free swarm tier
has no HTTP client, 18 of 18 nightly smoke reports from it contained zero real measurements, and
*"an agent asked for a number it cannot obtain will produce a plausible number"* `[R
src/orchestration/lane-registry.ts:4-14]`. `cheapestCapableLane()` makes the cost cascade executable
— free tier sorted first, but only *reached* for work it can finish.

The **handoff gate** checks report *contents*, on the argument that the pre-existing co-sign
consumer gates on *who signed* and eighteen empty reports had real signatures and real artifact
URLs. Its three load-bearing rules: a `measurement` typed as a bare `number` is refused (it must
carry `{value, corpus, config}`); a listed set of observed placeholder strings — `"no issues found"`,
`"LGTM"`, `"verified"` — is refused as prose; and a voice that did not report contributes nothing,
so silence never becomes consensus.

The **write-lease fence** stores leases in `git rev-parse --git-common-dir`, i.e. inside the main
repo's `.git`, so every worktree sees one registry that cannot be committed, staged by a stray
`git add -A`, or produce a merge conflict. Leases expire (4h default); overlap detection
over-approximates deliberately, because a false conflict costs a conversation and a missed one costs
a night's work.

---

## 3. Results

### 3.1 Merge volume

| | count |
|---|---|
| merged in window | 21 |
| open at window close | 9 |

Merged: `#312 #313 #225 #272 #314 #315 #316 #317 #318 #319 #320 #321 #322 #323 #324 #325 #326 #327
#332 #337 #338`. Open: `#328 #329 #330 #331 #333 #334 #335 #336 #339`. `[V gh pr list]`

`#225` and `#272` are older branches that landed inside this merge window rather than sprint work.

### 3.2 The reputation ledger

Four independent defects in one write path, each found by reading the live database rather than the
generated types.

**The live scoring path had no clamp.** The documented pipeline clamps to the database's own
`CHECK` range; the two live write sites had none and a floor-only guard respectively. The failure
mode is worse than a missing guard: an out-of-range value is *rejected*, so the score does not move
at all — *"a scoring system whose severe punishments are the ones that quietly fail is worse than one
with no punishments"* `[R #314]`.

**The double-count was real, and its own guard could not see it.** `#316` audited eleven writers and
concluded there was no live double-count — *"agreement of arithmetic, not a mechanism"* — then built
a reconciliation invariant (`after − before === applied`) to catch it. `#326` replayed a real writer
on production inside a rolled-back transaction and measured **+7 drift** on a +7 delta, and showed
why the invariant is structurally blind: the trigger overwrites the caller's `before`/`after` with
its own internally consistent pair, so **the doubled row reconciles**. `[R #326]` The distinction
`#316` missed is *ordering*: a caller that writes the score **before** the insert has the trigger
add the delta a second time, unconditionally.

**Zero-delta events were the majority class and could not be inserted.** The helper every writer was
being pointed at guaranteed a not-null violation for any zero-delta event under the recommended
`applier: 'trigger'` mode — and zero-delta is **52.5 %** of that ledger `[R #329]`. The purpose
gate's entire evidence that it works *is* zero-delta rows.

**A writer that had never written a row.** `#326` classified writer #12 as *behaviourally safe*.
`#331` probed it and found two unconditional failures — an `ON CONFLICT` clause with no arbitrable
constraint, and event types absent from the table's `CHECK` whitelist — so it has inserted nothing
in its life. Its only caller downgrades the throw to a warning and still returns success, and its
test suite mocks the database layer and asserts synthetic success rows. `[R #331]`

### 3.3 Measurement infrastructure

`#327` shipped a corpus manifest and a **refusal**: `recordMeasurement()` throws unless the ruler is
complete — corpus id, full content hash, case count, configured *and observed* family width,
strictness, and both quorum gates. The argument for a refusal rather than a convention is empirical:
the schema already had `corpus_version` and `manifest_dataset_id` columns and **both are null in
every row** `[R #327]`. A field you are asked to fill in politely ends up null.

`#328` then found the width half of that ruler was being fed corrupt data. One classification query
over the provider-list column returns **0 rows out of 1,825 that can name a provider family**: three
quarters empty arrays, a slice carrying a *count* smuggled into a name array (`array_length` reports
1 where the run reached 2 — understating in the safe-looking direction), and the remainder naming a
gateway rather than a family. Every family width ever derived from that column was fabricated. `[R
#328]`

`#330` (open, no DDL applied) read the unscoped accuracy view and found it blends five incompatible
rulers into one number labelled `ROBUST`, where `ROBUST` means only "≥100 rows". Per-ruler tallies
sum exactly to the blend, so it is arithmetic rather than sampling: **every true positive HAL has
ever recorded comes from one ruler**, and the other four contribute false positives and no true
positives. The blended view understates the one real measurement by roughly 0.62 F1. `[R #330]`

### 3.4 Security

`#320` removed twelve credential-bearing files from the tree and explained why every check had been
green: the CI secret scanner scans the **commits in a push/PR range**, and these predated the
workflow, so recent runs logged *"0 commits scanned"* and reported clean. Separately, one file was
already listed in `.gitignore` — added *after* it was committed, and **gitignore does not untrack**.
Someone did the thing that feels like the fix. The new resident-secret job asks the different
question — *is a secret here right now* — and is baselined per file as a ratchet, because a hard
fail over pre-existing findings gets switched off within a week.

`#337` closed the deeper gap: **every secret control scanned files; nothing scanned what an agent
publishes.** A pull-request body goes from an agent's context to a public URL without touching the
repository. That gap fired twice on the same day.

`#333` found, and deliberately did not fix, an authorization hole on the money path: the
contract-party check lives inside a branch that only runs for database-issued keys, so a shared
environment key authenticated as *unidentified and unrestricted* and skipped the check entirely on
four contract mutations. `#338` fixed it in its own reviewed PR, shadow-first.

### 3.5 Distribution

`#317` made the engine a drop-in OpenAI endpoint (`POST /v1/chat/completions`, `GET /v1/models`),
mounted at `/v1` because that is the path every OpenAI client appends to a base URL. Response body
is exactly OpenAI's shape; everything added rides in headers. Two refusals are load-bearing:
streaming is rejected **with a reason** rather than silently ignored (HAL scores a complete answer,
and a client that asked for chunks and got one blob would hang), and model family is resolved
locally and never taken from an upstream header, so a receipt's *"verified across N families"* cannot
be inflated by a third party's self-report. Default off.

### 3.6 Marketplace

`#333` measured the shape of the stall: 148 of 184 contracts sit at `fulfilled` — delivered and
unpaid, oldest 77 days — because `escrowed → fulfilled` has a drain worker and `fulfilled → settled`
has none, and only the buyer can release it. `#339` was dispatched to build that drain and
**refused**, on one query: not one of the 148 has a buyer verdict that failed to settle. There is no
stranded-retry case; every one is waiting on a buyer who never came. A drain would not recover stuck
payments, it would pay providers for work nobody verified — the precise inverse of the product's
only promise. `#339` therefore ships a classifier with **no write path at all**, and a test asserting
the absence of one. `[R #339]`

---

## 4. MISTAKES

Standing practice in this repository is that failures are documented, not hidden. This section is
the most useful part of the report.

### 4.1 A shared test-count baseline was wrong in every lane — and then eight lanes invented the same wrong explanation

Eight parallel lanes were briefed with one full-suite baseline: **3442 passed / 12 failed**.

No lane could reproduce it. Four said so explicitly, in nearly identical language:

- `#324` — *"The dispatch specified 3442 passed / 12 failed. That number is stale, not contamination"*, then measured 3481/11 on two independent pristine runs.
- `#325` — *"The brief's stated baseline was 3442 passed / 12 failed and I could not reproduce it. Cause identified: `origin/main` advanced two commits past #321."*
- `#326` — *"it is not reproducible, and it is not a parallel lane"*, then measured three separate commits: 3376/11, 3475/15, 3481/11.
- `#327` — *"The baseline differs from the 3442 / 12 I was briefed with. `origin/main` advanced to [a newer commit] … I measured rather than assumed."*

Every one of those diagnoses is **commit-based**, and every one is wrong. `#334` established the
actual cause: **a test count is environment-scoped. It is not a property of the commit.** Three
different totals now exist for the *same* commit — **294** collected in the briefing checkout, **328**
in one lane, **329** in another `[R #334]`. A fresh `npm install --legacy-peer-deps` collects a
different set of suites than a long-lived `node_modules`.

Two things make this the sprint's most instructive failure:

1. **Four independent agents converged on the same wrong cause.** Each measured honestly, each
   reported the discrepancy as instructed, and each reached for the one variable that had visibly
   changed (the commit). Convergence looked like corroboration. It was a shared blind spot — the
   Pythagorean-Comma case, in the wild.
2. **The correct diagnosis was only available to the lane that compared across environments.** No
   amount of care *within* a lane could have found it, because within one environment the number is
   stable.

The fix in `#334` is `src/orchestration/baseline-ledger.ts`: a lane records its own before/after in
its own environment, and a delta is certified only when `after.suites − before.suites` equals the
suites the **diff itself** explains, counted from the diff rather than asserted. Its `caveat` line
states the limit rather than hiding it: suite count is a *necessary* condition for comparability,
never proof the two runs were identical.

By the end of the window, later PRs (`#328`, `#329`, `#330`, `#331`, `#333`, `#336`) all opened their
test sections with some form of *"counts are environment-scoped; the delta is the claim"*. That
propagation is the real remediation.

### 4.2 A ~31-bit nullifier shipped and provably collided at live volume

`#321` (merged 08:53Z) shipped a public statement layer for reputation deltas including a scoped
nullifier. `#325` (merged 17:35Z, 8.7 hours later) found the nullifier was **one field element** —
32 hex characters over roughly a 2³¹ space.

It was not argued to be weak. It was **run**:

- Sweeping distinct secrets against a fixed scope, the first collision lands at the 62,852nd secret,
  found in 4.2 seconds on the sprint machine.
- The ledger holds ~152k rows and the nullifier was scoped per score event, so the expected number of
  colliding pairs at current volume is ≈ 5.7.
- The de-duplication tag — its one actual job — would therefore have reported roughly six honest
  events as replays of unrelated events. **A colliding nullifier is worse than none: it manufactures
  false "already counted" verdicts.**
- The secret is also recoverable by brute force; the same PR measured this repository's own hash rate
  to bound the cost.

Both attacks are now tests, not comments — *"a privacy claim backed only by prose is a privacy claim
nobody checked"* `[R #325]`.

The correction widened the secret to eight field elements absorbed whole, with no one-element
intermediate anywhere on the path from secret to published value, because no choice of secret
*source* can rescue a 31-bit *output*. The frozen digest KAT moved, which was safe exactly once —
zero rows of that type existed on disk `[R #325]`.

**What went wrong upstream:** `#321` correctly documented its own weakest part (*"the nullifier
secret is salt-derived … do not publish a privacy claim for it"*) and named the *source* of the
secret as the limitation. It never examined the **width of the output**. An honest limitation section
about the wrong axis reads as diligence and provides none.

### 4.3 A double-count guard declared safe on reasoning that could not detect the failure it guarded

Covered factually in §3.2. The lesson is narrower than "the audit was wrong":

`#316` chose a *reconciliation invariant* (`after − before === applied`) as the guard's detector, and
that detector cannot observe the failure, because the same trigger that double-applies also rewrites
both operands into a consistent pair. `#326` put it precisely: *"Reconciliation catches a lying
ledger; it does not catch a doubled score."*

The correct test of a proposed guard is not *"does this invariant hold on good data?"* but *"can this
invariant be false when the bug is present?"* `#326` answered that by constructing the bug on
production inside a rolled-back transaction and watching the guard stay green.

Two secondary defects rode along:

- `#316`'s ratchet counted **files** with a supabase-js-shaped regex, so it could not see a raw-SQL
  writer, and asserted a bound of 11 while writer #12 had already existed for months. Its own header
  claimed *"writer #12 fails this test on arrival"*; it did not. `[R #331]`
- `#316`'s writer classification put three writers in production route directories; its own test
  corrected the audit to `src/testing/`. The PR body records this against itself, which is the
  behaviour to keep.

### 4.4 A gate with 63 tests that nothing ever called

`#319` shipped `lane-registry.ts` and `handoff-gate.ts` with a reported 63 tests. `#334` found no
caller outside the test file. Re-verified here on `main` at `778504d`:

```
$ grep -rn "evaluateHandoff\|canAssign\|cheapestCapableLane\|eligibleVerifiers" \
    --include=*.ts src scripts tests | grep -v "^src/orchestration/"
tests/lanes-and-handoff.test.ts:11,12,13,19,77,87,91,104,115,…
src/services/peer-verification-reader.ts:123  ← an unrelated local variable of the same name
```
`[V]` The only real references are the test file. This is **Pattern G — cold module disease** — from
the project's own roadmap: *fully designed, documented, and never wired.*

It is worse than not having built the gate, because the roadmap records the gate as done. In the
same window, eight lane reports were graded by a human reading prose — exactly the review the gate
exists to replace.

A minor discrepancy this report could not resolve: `tests/lanes-and-handoff.test.ts` contains **49**
`it(`/`test(` declarations `[V grep -c]`, while `#319` reports 63 tests. The likely explanation is
table-driven cases expanding at runtime, but it was not confirmed. Recorded as `unknown` rather than
smoothed over — and it is itself an instance of the rule the gate enforces: a count without its
method is not a measurement.

### 4.5 A jest reaper blocked every test in the repository by exporting the wrong shape

`#332` addressed a real and measured problem — cancelled runs left 101 orphaned worker processes and
4,020 CPU-seconds alive, and the full suite had gone from ~125 s to over 600 s `[R #332]`.

Two mistakes inside the fix:

1. **The first selection rule was `anything matching /jest/`.** A jest *parent* whose shell has
   exited has an absent parent pid and looks orphaned — *"our lanes run detached, so that is the
   normal case"*. Shipped, that rule would have SIGKILLed three teammates' live suites. A test caught
   it. The corrected rule targets a jest *worker* whose parent pid is gone, which cannot be reporting
   to anyone regardless of age.
2. **The first version exported an object where jest requires a function.** jest rejected the
   `globalSetup` module and **every test in the repository failed to start.** The reaper's careful
   fail-open internals never ran, because the failure was in the module contract, not the logic.

*"Fail-open logic does nothing if the export contract is wrong."* `[R #332]` The same class recurred
one file over: `publication-guard.js` had to add a `require.main === module` guard, because
`require`ing it to test it executed it, read stdin, and killed the test runner.

### 4.6 A settlement drain worker was designed and then abandoned

Covered in §3.6. The mistake being documented is not the abandonment — it is that the drain **looked
obvious** and would have been built. 148 delivered-and-unpaid contracts with a missing state
transition is a textbook worker-shaped gap. One query about buyer verdicts inverted the conclusion.

Two traps `#339` pinned as tests, both of which a plausible implementation would have hit:

- **Age is not consent.** A 77-day-old contract is still not auto-settleable; the tempting heuristic
  says nothing about whether the buyer approved.
- **A zero satisfaction score is a rejection, not a missing response.** Treating `0` as "no answer
  yet" would drift rejected deliverables back into the settle queue.

It also closed a reporting trap that would have survived any worker: 24 rows carry a settlement
timestamp from a legacy pay-at-escrow path while still sitting at `fulfilled`, so **any query written
as `settled_at IS NOT NULL` counts 31 settlements where 7 exist** `[R #339]`.

The finding that matters for the roadmap is not a backend one: *the marketplace's provider half works
and its buyer half has never been exercised by anything but a script.*

### 4.7 Secret scanning covered files but never covered what an agent publishes

Two controls existed and both scanned files. Neither could see a pull-request body, which is text
that goes from an agent's context to a public URL without ever touching the repository.

The compounding error is the premise. `CLAUDE.md` stated the repository was *"Private, proprietary"*.
`gh api repos/DealAppSeo/repid-engine --jq .visibility` returns **`public`** `[V]`. Every agent that
read that file inherited a false model of its own audience, and wrote accordingly — including a PR
that published a detailed account of a committed production credential, naming the file and the host
project, and another that published live table counts and infrastructure names. Both were written in
good faith.

`#337`'s design conclusions are the durable part:

- It **fails closed**, deliberately unlike its siblings. The write-lease fence and the jest reaper
  fail open because their worst case is a collision or a slow suite. This one's worst case cannot be
  undone — a reader may already hold what was published.
- It **states its own limit**. Prose cannot be regex-judged: a row count in a sentence has no secret
  shape, and a pattern broad enough to catch it would fire on every honest engineering claim and be
  disabled within a week. So instead of pretending to judge prose, it prints the repository's
  visibility loudly before every publish. *"An agent that knows the audience is the internet writes a
  different body."*
- It was **proven on its author, three times**, including blocking the creation of its own PR
  (because that command wrote the body file and published in one shot, so the file did not exist at
  scan time — correct behaviour) and misfiring on `/tmp/...` paths, since the shell here is Git Bash
  and those paths are meaningless to Node on Windows. *"A guard that misfires on the most ordinary
  path in the repo gets switched off, and then it protects nothing."*

### 4.8 Smaller mistakes worth keeping

**A test that depended on the time of day.** `#322` merged green; `main` went red **22 minutes
later** with nothing changed in between. A fixture pinned a fixed clock while the hook under test is
a subprocess reading its own `Date.now()`, so the lease was active only until the wall clock passed
the hour. Worse: the six pre-existing equivalence cases computed their expected verdict with
`Date.now()` too, so after the hour **both sides agreed on "allow" and the assertions still passed** —
they had silently stopped testing enforcement at all. *"A test that depends on the time of day is
worse than no test. It lands green and rots — and here it rots into a false green on a safety
fence."* `[R #323]`

**The cost ledger was inventing prices.** A pricing lookup fell back to *the first model in that
provider's table* when a model had no entry, and returned it as if measured. One model inherited
another's rate across ~26k calls and reported a figure that was **59 % of apparent total spend** — on
a model the codebase explicitly classifies as free. The money never left the account. The fabricated
number reached a public cost endpoint, a status digest, and a written recommendation to route away
from that provider, which was wrong because of it. `[R #318]` An unpriced model now returns 0 with a
loud warning that says *"not priced"* and explicitly not *"free"*.

**The fence silently disabled itself while looking healthy.** During `#322`, a payload carrying a
POSIX-style working directory made the guard's subprocess call fail to change directory on Windows,
`git` never ran, and the hook exited 0 — allowing every write. `[R #322]` The worst possible failure
mode for a guard, and it was found by testing the hook as a subprocess rather than trusting the
module.

**Rolling back to the oldest file on disk would have reverted four months.** `#330` found the oldest
migration file for a view was not what was actually live; a later migration had redefined it and
renamed a column. Its rollback is captured verbatim from the live definition instead. Standing rule
proposed: **roll back to what was measured, not to the oldest file.** `[R #330]`

**A green test suite over code that cannot execute.** `#331` found the test for the dead writer mocks
the database layer and hands back synthetic success rows — green for months over a path that throws
on every call. `[R #331]`

---

## 5. The lane/fence system: what it caught, and where it failed

### 5.1 What it caught

**A cross-lane finding was routed instead of patched.** `#333` discovered the escrow authorization
hole inside its own fence but deliberately out of scope, wrote it up as *"an authz change on the
money path belongs in its own reviewed PR"*, and `#338` fixed it hours later, shadow-first with a
measurement plan. That is the fence producing better work than a lone agent would have: the finder
was mid-flight on a read-only PR and would otherwise have bundled a live authz change into it.

**"Found and NOT fixed" became a first-class output.** `#326`, `#327`, `#328`, `#329`, `#330`, `#331`,
`#333`, `#336` each carry an explicit out-of-fence section naming file, line, mechanism and owner.
The fence converted "I noticed something" from a lost thought into a routed work item.

**The write-lease fence refused a live overlapping claim.** Demonstrated end to end in `#322`, with a
refusal message that names the conflicting lane and its purpose and says *"resolve it with a
sentence, not an overwrite"*.

**The publication guard blocked real values three times, on its own author.** §4.7.

**Scope discipline held under pressure.** `#330` performed a full migration design against the
production database with **zero DDL applied** — every statement a `SELECT`, including both view-body
validations, which caught two errors in its own draft before review.

### 5.2 Where it failed

**The gate was never wired.** §4.4. The two hook-enforced mechanisms worked; the two library
mechanisms were bypassed for the entire sprint because nothing called them. The pattern is clear and
worth generalising: **the fences enforced by the harness held, and the fences enforced by convention
did not.**

**Fence granularity produced a deadlock that required a manual exception.** `#326` could not delete
its own legacy code branches because the ratchet test asserting the writer allow-list lives outside
its fence, so guarded and unguarded code had to coexist. `#331` was granted an explicit exception to
edit that one test file. A fence drawn per-directory does not match a change whose unit is
"implementation plus the test that pins it".

**The fence protects files, not the machine.** Four concurrent lanes turned the shared host into the
contended resource. Credential-dependent suites lose a 5-second race arbitrarily under load, so the
*set* of failing suites flapped between runs while its size stayed constant — `#328`, `#331` and
`#333` all independently report this, and all three demonstrate it by re-running the flapping suites
in isolation, where they pass. `#328` states the correct discipline: *"treat any single full-suite
failure list from this sprint as a sample, not a fact."* `#332` fixed the worst contributor
(orphaned workers), but the write-lease has no concept of CPU, and nothing arbitrates it.

**The fence prevents collision, not duplication or staleness.** `#326` and `#331` each wrote their
own script to enumerate the same writer set, and `#331` had to correct `#326`'s line numbers because
an intervening merge had moved the file. Two lanes doing the same census is cheaper than two lanes
overwriting each other, but it is still waste the system does not see.

**The fence had nothing to say about what leaves the building.** All four mechanisms are about the
repository. The two worst disclosures of the window travelled by pull-request body. `#337` is the
first control on that channel and it exists only because the failure happened twice in one day.

**A fence cannot fix a bad premise.** Every lane behaved correctly given `CLAUDE.md`; the file was
wrong. No enforcement mechanism in the list checks that the context the agents are handed is true.

---

## 6. Learnings

1. **Convergent agreement between independent agents is not corroboration.** Four lanes reached the
   same wrong diagnosis of the baseline discrepancy because they shared a blind spot, not because
   they cross-checked. The rule that agreement gates judgement but never gates facts earned its
   keep — and the correct answer came only from comparing *across* environments, which no single
   lane could do.

2. **A test count is a property of an environment, not of a commit.** Three totals at one commit.
   Report deltas measured in your own tree, never absolutes borrowed from a brief.

3. **Ask of any guard: can its detector be false while the bug is present?** The reconciliation
   invariant, the presence-not-liveness credential check, and the `Date.now()` equivalence cases all
   passed the wrong question and shipped.

4. **A limitations section on the wrong axis is worse than none.** `#321` documented its nullifier's
   secret *source* honestly and never looked at output *width*. The candour made the omission harder
   to see.

5. **Harness-enforced beats convention-enforced, by a wide margin.** Both `PreToolUse` hooks did
   their job. Both importable libraries went uncalled. If a rule matters, it belongs where the model
   cannot route around it.

6. **Cold module disease is worse than an unbuilt feature**, because the roadmap records it as done.
   The wiring is not the boring last 5 %; it is the part that makes the other 95 % exist.

7. **The measured refusal is a first-class deliverable.** `#339` produced no worker and is among the
   most valuable PRs of the window. Building the obvious thing would have converted *pay on verified
   delivery* into *pay on delivery anyway* and quietly falsified the product's only real claim.

8. **Fail-open and fail-closed are per-guard decisions, and both are sometimes right.** The lease
   fence and the reaper fail open because their worst case is recoverable. The publication guard
   fails closed because a published key cannot be withdrawn. Getting this backwards either way is a
   defect.

9. **A guard that cries wolf is a guard that gets deleted.** The secret ratchet is baselined per file
   rather than hard-failing over pre-existing findings; the publication guard states visibility
   rather than regex-judging prose; the lease fence claims territory without confining its holder.
   Each is a deliberate reduction in strictness that buys durability.

10. **Probe, do not check.** Presence of a credential is not liveness of a credential. Four tests
    reported timeouts against a dead URL as defects in the thing under test, until `#328` replaced
    the presence check with a bounded probe that skips honestly or fails with an explicit
    `ENVIRONMENT FAILURE — this is NOT a quality regression` banner.

11. **The public/private premise is load-bearing context.** It changed what every agent should have
    written, and it was wrong in the one file every agent reads first.

---

## 7. Open items at window close

| item | where | status |
|---|---|---|
| 9 PRs unmerged, several stacked on the same subtrees | `#328`–`#331`, `#333`–`#336`, `#339` | open |
| The handoff gate still has no caller in the boot path or CI | `#334` | open, and `#334` itself does not wire it |
| Three database defects designed but not applied — trigger ordering, audit-table range checks, the unscoped accuracy view | `#330` | needs a human to apply; one is a live-behaviour change |
| The public accuracy view still labels a five-ruler blend `ROBUST` | `#330` | open |
| The provider-width column's corrupting writer | outside every lane's fence | reported, unfixed |
| Marketplace buyer leg has never been driven by anything but a script | `#339` | product gap, not a worker gap |
| Rotation of the credentials `#320` untracked — deletion is not rotation, and history is public | `#320` | human action |

---

*Evidence over claims. Sequence over schedule. Failures documented, not hidden.*
