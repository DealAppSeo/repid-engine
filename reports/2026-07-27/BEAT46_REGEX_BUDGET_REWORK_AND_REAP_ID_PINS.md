# Beat 46 — the regex budget reworked, the reap's id pinned, and a reported figure demoted

**Date:** 2026-07-27 · **Repo:** repid-engine (+ trinity-symphony-shared) · **Beat:** 46

## Queue at close [V sql]

`trinity_tasks`: pending **0**, in flight **0**, `claim_count > 0` on **0** rows, max `claim_count` **0**,
29 claimed in 24h. Seventh consecutive beat of the T12 dispatch hold.

## 1. repid-engine #231 — reworked as ONE change (Beat 45 retracted it)

Beat 45 withdrew this PR and its "11 mutations, 10 killed" score. Four findings, addressed
together rather than in sequence, because the last two send-backs in this loop each found a
hole *inside* the fix for the previous one.

**(a) The budget covered spawn, not the match.** The deadline was armed before
`new Worker(...)`. Measured directly this beat: `construct->online` is **98–142 ms idle**
(12 samples, 0 over 250 ms), and Beat 45 observed **136–1172 ms under parallel load, 8 of 12
over 250 ms**. So between 40% and 470% of the entire 250 ms budget was spent before the regex
ran a step. The consequence is not a slow test but a **wrong verdict**: an honest pattern on a
busy box reads as pathological, and the failure is load-dependent, so CI lands on the good side
of it while an idle laptop does not. The clock now starts on the worker's `online` event.
Thread startup gets `WORKER_STARTUP_CEILING_MS = 30_000`, reported as `error` and never
`timeout` — an infrastructure fault is not evidence about the operator's regex.

**(b) Termination was pinned by the module's opinion of itself.** `activeWorkerCount()` is
module-private state read by a test of the same module. Replaced as the load-bearing pin by
`process.cpuUsage()` — an OS-level measurement covering all threads of the process, which this
file cannot fabricate. Measured on this hardware:

| | exit after terminate | CPU over a 600 ms window |
|---|---|---|
| terminated | 6–8 ms | **0–3% of wall** |
| leaked | never | **77–97% of wall** |

The gate is 40%, sitting in the middle of an order-of-magnitude gap — not a tuned threshold.
`terminate()` does interrupt a spinning irregexp match, verified rather than assumed. The
counter is kept as an operational leak gauge, explicitly demoted, asserted `toBe(0)` rather
than `toBe(before)` (which pins "no NET change", so an already-wrong baseline stays wrong).

**(c) A timed-out check was `rejected`/`assertion_failed`.** These verdicts feed RepID, so
that debits the **agent** for the **operator's** non-terminating pattern — while the identical
pattern caught one layer earlier by `hasBacktrackingRisk` at parse time already returned
`unclear`/`unverified`. Which guard catches it cannot change whose fault it is. `CheckOutcome`
gains `evaluated`; an unevaluable check now outranks a failed one (both refuse to approve, so
the safety property is unchanged, but `rejected` asserts a complete grade that never happened).
A counterweight test pins that ordinary failures are **still** rejected, so the distinction
cannot be deleted into a grader that never blames anyone.

**Mutation battery: 10 applied, 10 killed.** Baseline verified green first (65/65), every edit
asserted to have landed. The leak mutant is killed by the CPU test **by name** (confirmed with
`--verbose`, not inferred from a count).

**The three suites failing locally are pre-existing** — `hal-accuracy-summary`,
`trinity-swarm-health` (both hit `src/db` with dummy credentials) and `hal/golden-math` (live
providers). **A/B confirmed:** the identical 12 tests fail with my three files reverted. None
imports either module touched here. #231 also had its only merge conflict resolved — the
append-only ledger, not code — and is now MERGEABLE.

## 2. trinity-symphony-shared #34 — round-4 fix (round-3 verification: SEND BACK)

Third verification, third round in which a HIGH hole sat inside the previous round's fix.
Both findings reduce to one root cause: **the reap's targeting of a specific row by `id` was
unverified end to end.**

- **HIGH #1** — the select was pinned by a regex requiring only the word `metadata`. Dropping
  `id` left all 28 tests green; in production `task.id` becomes `undefined`, node-pg binds that
  as SQL `NULL`, and `WHERE id = NULL` matches nothing. The reaper would reap and refund
  **nothing, forever**, while logging as though it were working — which silently disables the
  refund the whole cap depends on.
- **HIGH #2** — `buildReapParams`' first bind (the id) was asserted nowhere. Hardcoding it to
  `999999` left all 28 green with the identical silent no-op.
- **LOW** — `REAP_RELEASE_STATUS` was the only reaper trigger constant without a literal pin.

**The fix does not restate the column list.** Re-listing it would pin the test to a copy of the
constant and prove only that two strings written together agree. Instead the test reads the
reaper's own source for every `task.<prop>` it dereferences and requires each to be selected —
pinning the actual invariant (*the fetch covers the use*) and continuing to hold when someone
adds a consumer later.

**Battery: both HIGHs, the LOW, and two controls (dropping `metadata`; the round-2 one-second
staleness window) — all killed.** Baseline green first (69 assertions, 5 suites). CI green on
the new head `555bb67`.

The derived check carries a **guard on the guard** — it asserts `task.id` was actually found,
so a broken matcher fails loudly instead of passing vacuously over an empty list. That guard is
not decorative: **it fired during development** on a mis-written word boundary (`\B` for `\b`)
and told me the extraction had broken rather than going green. Renaming the loop variable so
the extraction genuinely finds nothing is killed (exit 1, verified). An earlier mutant that
renamed the variable but aliased it straight back is recorded **EQUIVALENT by construction**.

## 3. repid-engine #233 / #225 — a reported figure demoted to [R]

Independent verification (`BEAT46_VERIFY_225_AT_HEAD_AND_233.md`) returned **SEND BACK on
both**, and confirmed three of #233's four claimed fixes hold under mutation. It also
independently **recomputed** the 120-relabelling sweep from a separate implementation — exact
match on every published figure (n=120, 0 empty, 4 unbounded, 44 with ceiling cut ≥25%, lower
edge [28.5, 50.33] with the unperturbed value as the exact median).

The real finding was one level up from code. The corpus header ranked the **28/30
second-labeller** result first and called it *"the strongest evidence, and the one to cite"* —
while **no data file, fixture or test in any branch carries that labeller's 30 values**. The
verifier enumerated the search and found nothing, so the figure can be neither recomputed nor
falsified from this repository. For patent enabling-disclosure material that is exactly the
defect this module's tests exist to catch: **not an unpinned column but an unpinned fact.**

Fixed by ranking the reproducible sweep first and tagging the re-labelling
`[REPORTED; NOT REPRODUCIBLE FROM THIS REPOSITORY]` with an explicit *must not be cited as
though it were*, plus the concrete route to promoting it. **Prose is what drifts, so the
disclosure is pinned as a property**: restoring the confident wording fails, and promoting the
unreproducible defence back to first fails. Both mutations run, both KILLED, baseline green
before and after. The pin deliberately cuts both ways — committing the 30 labels later also
fails it, correctly, because the caveat must then be removed rather than left as a false apology.

**#225 was NOT folded into one unit.** The verifier recommended the two land together, and I
attempted the branch-to-branch merge; **the repo guard hook blocked it (no self-merge — merges
are Sean's gate) and I did not override it.** The ordering constraint therefore passes to Sean
verbatim, below.

## 4. Mistakes / process notes

- **My own mutation harness's "assert the edit landed" check was vacuous.** It diffed against
  `HEAD`, and the rework was uncommitted, so it reported "landed" for *any* edit. The guard Beat
  45 added to stop exactly this failure was itself the weaker property. Fixed to compare against
  a pre-mutation copy.
- **A run that timed out before its restore line left the mutant in the working file, and the
  next two mutations silently used it as their baseline.** Caught only because the re-run of M1
  reported DID-NOT-APPLY — the mutation had already been applied. All results were discarded and
  re-run from a verified-green baseline. *A mutation score is meaningless without both guards.*
  A `trap` on EXIT/INT/TERM is not sufficient either: a hard kill skipped it once more, so
  golden copies now live outside the repo.
- **A quoted heredoc silently ate one level of backslashes**, so a `sed`-style patch matched
  nothing and a regex landed as `\B` instead of `\b`. Patch scripts are now written as files.
- A `SURVIVED` verdict rested on captured output that had crashed on a Unicode decode error; the
  runner's exit codes were separately verified to distinguish pass (0) from fail (1) before any
  survivor was believed.
- **Weaker-property count: nine in nine beats.** This beat's instance was in my own verification
  tooling rather than in shipped code — which is the same failure wearing a different hat.

## 5. Open for Sean

1. **`trinity-symphony-shared` #34 — round 4 pushed, CI green.** Seven beats of T12 idle end when
   it merges. It owes a fourth independent verification (next beat's first item); the last three
   rounds each hid a hole inside the previous fix, so I would not call it ready without one. Your
   design question still stands: should an exhausted task get its own terminal status rather than
   sitting in `pending`?
2. **repid-engine #225 + #233 — MERGE ORDER MATTERS, and I could not remove the constraint.**
   #225 alone still ships the unpinned `regretAtPrice` column (verified this beat: sign-flip and
   penalty-deletion mutations both survive 21/21 on its head). #233 is the fix and is stacked on
   it. **Land them together, or #233 immediately after #225, with no intervening state where
   `main` carries the unpinned version** — it is patent enabling-disclosure material. `--auto`
   cannot arm #233 while it is based on a feature branch.
3. **repid-engine #231 is reworked and now MERGEABLE**, but stays DRAFT: I wrote it, so it needs
   an independent verification before it is ready.
4. **Carried unchanged:** Patent #1 RTP gap (c) — one real Base Sepolia anchor via
   `npx tsx scripts/demo/proof-carrying-e2e.ts --live` with the funded attester (a hard line for
   this loop) · #216 needs conflict resolution · branch protection requires only `test`, so
   `crosscheck`/`gitleaks` can fail and a PR still lands · `PROOF_ENQUEUE_HAL_MODE=enforce` ·
   the public 500 on `GET /api/v1/marketplace/browse` · the dead `jest` key in `package.json`.
