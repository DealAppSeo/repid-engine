# Beat 44 — the claim cap reworked twice under independent fire, and the seven-beat ReDoS item closed

**Date:** 2026-07-27 · **Repos:** `trinity-symphony-shared` (PR #34), `repid-engine` (PRs #228 verified, #231 new)

---

## 1. What this beat set out to do

Beat 43 closed with four named items. This beat took three of them:

1. Independently verify repid-engine #228 (the Patent #2 measured-regret disclosure) — **highest value was a second labeller**, since the whole measurement rests on labels I wrote.
2. Land the three fixes #34 needed so the T12 dispatch hold could end.
3. The item carried unactioned since Beat 33 — **replace `hasBacktrackingRisk` with a timeout budget** — which Beat 43 said should be *done or explicitly dropped*.

Item (3) from Beat 43's list — the shape-keyed floor rung — was deliberately **not** started: it touches `proof-tier-policy.ts`, which a verification agent was working in for the whole beat.

---

## 2. #228 — verified SAFE TO MERGE, and the band is robust [V]

A verifier with no authorship re-labelled all 30 scenarios from the scenario text alone, with `requiredTier` and `why` stripped, before diffing against mine.

- **Disagreement: 2/30 = 6.7%.** Both disagreements land exactly where my own `why` fields pre-registered a judgement call (`cite-eas-anchor`: does "this UID anchors this root" survive revocation? and `high-reliability-low-stakes`: is an internal check asserting committed-memory state at all?). A corpus tuned to its scorer would not have flagged its own ambiguity in advance.
- **Substituting the full second label set moves the crossover band by ZERO** — `(37.857, 661.000)` either way.
- Sweeping **all 120 single-label perturbations** (30 scenarios × 4 alternative rungs): **0 empty bands.** The qualitative claim survives every single-label relabelling.

Three real findings, none blocking:

- **[MEDIUM] The upper edge ~661 is far less precise than the lower.** It is a step function of the policy's under-proof count, currently exactly 1; 44 of 120 perturbations roughly halve it (→310–330) and 4 send it to infinity. The lower edge is genuinely stable (28.5–50.3, median exactly 37.86). For a patent enabling disclosure "~661" reads as a measured constant when it is really *661 conditional on this corpus yielding one under-proof.* **Needs one sentence of hedge.**
- **[MEDIUM] `regretAtPrice` is unpinned** — flipping the regret sign, and dropping the under-proof penalty entirely, both survive all 21 tests. The published R@10/R@40/R@200 columns could be sign-flipped with CI green. It does **not** reach the headline band (`crossoverPrice` recomputes from well-pinned inputs), so it is a reported-output hole, not a claim hole.
- **[MEDIUM] The provenance argument is weaker than advertised.** Corpus-before-scorer is confirmed from history [V], but `proof-tier-policy.ts` was authored **95 minutes before the labels**. The no-import defence blocks mechanical derivation, not a human labelling with known behaviour in mind. **The 28/30 independent agreement is now the stronger evidence and should replace the temporal argument.**

The verifier also disclosed a limit on its own method: the corpus's blank-line block structure groups scenarios by tier, so its blind labelling was not perfectly blind, and 6.7% is a **lower bound** on true inter-labeller disagreement. Both of its disagreements ran *against* the block grouping.

**Not fixed this beat, on purpose.** Adding the `regretAtPrice` test and the hedge to #228 would invalidate the verification of the exact commit that was checked. They go in their own follow-up PR so the verified commit stays verified.

---

## 3. #34 — sent back TWICE, and the second HIGH finding was in the fix for the first

### Round 1 (`ee4a4ba`) — closing Beat 43's F1–F7

- **F1/F3 — the reaper refunds the claim it undoes.** A reap is blameless: the claimer died or restarted. Under the cap each reap cost the task one claim permanently. **[V sql] 2,408 real tasks have already been reaped ≥12 times, max 438** — agent lifecycle noise alone would have parked every one. Released now through `REAP_SQL` via `pgQuery`, refund `GREATEST(COALESCE(claim_count,0)-1, 0)`, status re-check inside the statement. Saturating on purpose: a counter that can go negative is a cap that can be farmed by provoking reaps.
- **F2 — the cap got a read side.** `claim_count` was written by the claim and read by *nothing*. Added `EXHAUSTED_TASKS_SQL` / `RESET_CLAIM_COUNT_SQL` / `isClaimExhausted` next to the claim, plus `scripts/ops/claim-exhausted.js`.
- **F5/F6/F7 — `tests/claimCallSite.test.js`,** which stubs the pg layer via `require.cache` and asserts what `getNextTask` actually **sent**. Kills the three F5 survivors; pins the bind count to a literal instead of deriving it from the SQL under test; tests the env lever against a probe value that cannot coincide with the default.

16 mutations, 16 killed. **One of my own tests failed the battery first:** MR5 (delete the lost-race guard) survived a draft asserting only the *absence* of a `task_reaped` log — the mutant produces the same absence by throwing into the outer catch, while silently abandoning the rest of the batch. *Absence of a signal is not evidence when the defect produces the same absence.*

### Round 2 (`f752573`) — the verification of my own fix

- **[HIGH] The F2 recovery tool had ZERO behavioural coverage.** Only `parseArgs` was exported. **Three one-line mutations each left 30/30 green while making the tool print "No parked tasks" forever**: binding `REAPABLE_STATUSES` instead of `CLAIMABLE_STATUSES` (parked rows sit in `pending`, never `doing`), binding the default instead of `maxTaskClaims()`, and binding `cap+1`. The test titled *"the recovery query looks for the SAME threshold the claim enforces"* pinned the SQL **string** and never pinned what the tool **binds**. This is the **seventh consecutive** weaker-property instance, and the **second in a row where the weak pin was itself the fix for the previous one.**
- **[MEDIUM] I introduced a path from a background janitor to the fleet's claim loop.** Moving the reap to `pgQuery` put it behind `direct-pg`'s **process-wide** circuit breaker (5 consecutive failures → 5-minute cool-down that throws for *every* caller). Because the loop continued past failures, a systemic DB problem across a ≤50-row batch would **guarantee** those 5 failures and take `getNextTask`, `claimTask` and the heartbeat down with it. Closed with `REAP_FAILURE_BUDGET = 3` consecutive failures, asserted to stay under the breaker threshold rather than merely commented.
- **[MEDIUM] F4 DROPPED rather than kept.** The reset-on-done was both decorative and wrong: (a) enumerating every claimable-status write in the file, a completed row leaves `CLAIMABLE_STATUSES` for good, so zeroing its count cannot affect what is served; and (b) the live `BEFORE UPDATE` trigger `enable_and_enforce_artifact()` rewrites `status → 'needs_artifact'` when the app writes `done` with no artifact — so the app would zero the counter believing the task was done while the row landed as the exact unproductive outcome the cap exists to bound. **A no-op that a commit message calls a fix is worse than an acknowledged gap.**

Also corrected: two comments the verification refuted — that HITL rows are how a human finds a parked task (259,432 pending / 1 approved *ever*), and "claimed, ever", which the refund makes false.

Round-2 battery: 14 mutations, 13 killed. **The survivor is recorded as EQUIVALENT with reasoning**, not papered over: a `--reset-all` flag cannot produce a mass un-park, because `RESET_CLAIM_COUNT_SQL` is `WHERE id = $1` with a parameterised bind and a numeric guard in front — the property is structural, and killing that mutant would need a second mutation to the SQL, which its own test catches. One new test also failed on first run, correctly: it asserted the no-mass-un-park property at the *parser*, where the guard does not live, and was rewritten to assert end-to-end that no argv reaches the database with anything but a single numeric id.

**Still open and NOT claimed as closed:** the second uncapped claim path (`constitutional-agent-base.js:1441` via `trinity-worker.js`) can drain the refund by claiming without incrementing — unresolved since Beat 43's F9, and still out of read-only reach. The reaper's own trigger conditions (survivor gate, 60-minute window, 50-row batch) remain unpinned, which matters more now that a reap writes to the counter.

---

## 4. #231 — the ReDoS item, closed in the shape the record argued for

Carried unactioned through Beats 33/35/37/38/39/41/42/43. **Closed — but deliberately not as worded.**

`hasBacktrackingRisk` has been bypassed **four times** across Beats 32/33/38. That is not bad luck: the set of dangerous regexes is not enumerable by inspecting the source string, so a better recogniser is the wrong shape of answer. `matchWithBudget()` runs the match in a **terminable worker thread under a wall-clock deadline** — the same totality argument that made the claim cap work: *bound the harm, not the shapes.*

A worker and not a timer, because a backtracking match is synchronous — `setTimeout` queues behind the very loop it is meant to cut short.

**The heuristic is demoted, not deleted:** it still gives a good operator error at contract-parse time instead of a silent per-task timeout forever after. It is simply no longer load-bearing.

The load-bearing test uses a pattern with **no group at all** (`a*a*a*…b`), which `hasBacktrackingRisk` demonstrably **accepts** — asserted, not assumed — and which the budget stops anyway.

11 mutations, 10 killed. Two notes against my own work:

- `activeWorkerCount()` exists because termination is invisible from the caller's side. A version that resolves the promise and abandons the thread passes every behavioural assertion while the runaway match keeps burning a core. Without the counter, *"the budget stops it"* would pin the weaker property (the **caller** stops waiting) than its own sentence (the **match** stops running) — the eighth near-miss of the same shape, caught this time before shipping.
- The `settled` guard is an **equivalent mutant** and is recorded as such at the site rather than wrapped in a test that would prove nothing.

Two timing assertions were loosened to 20 s after being observed failing once under CPU saturation from a parallel verification. A bound that fails under load trains people to re-run until green.

---

## 5. A process finding: nothing has ever actually been auto-merged [V]

`gh pr merge <n> --auto --squash` **exits 0 and arms nothing** when the base branch is unprotected. Confirmed by API:

| PR | base | `auto_merge` | state |
|---|---|---|---|
| #225 | main | null | clean |
| #228 | `feat/…proof-tier-policy` | null | unknown |
| #220 | main | null | clean |
| #216 | main | null | dirty |
| #231 | main | null | blocked |

`allow_auto_merge = true` and `main` requires the `test` check [V], so the mechanism should work **for PRs based on main**. #228 cannot be armed at all while it is stacked on a feature branch — it has to wait for #225 to land and then be retargeted.

**The lesson generalises: exit 0 from `gh pr merge --auto` is not evidence that auto-merge is armed.** Verify `auto_merge != null` after every attempt.

---

## 6. Fleet status — the dispatch hold is now in its fifth beat

`trinity_tasks`: **0 pending, 0 in flight, 0 rows with `claim_count > 0`** [V sql]. `repid_proof_queue` pending **40,557** [V sql]. The cap is still safe to deploy on day one — every risk it carries is forward-looking.

The hold continues because the runaway risk is unchanged until #34 merges, and #34 has now been sent back twice. That is a real cost under rule 1 and is surfaced rather than quietly repeated.
