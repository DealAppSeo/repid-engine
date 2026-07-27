# Beat 45 — the published regret columns pinned, the reaper's trigger conditions pinned, and a green claim of mine retracted

**Date:** 2026-07-27 · **Repos:** `repid-engine`, `trinity-symphony-shared`
**Queue at beat start [V]:** `origin/main` = `8eb9be0`. Open repid-engine PRs #225 (CLEAN), #231, #220 (CLEAN), #216 (DIRTY), parked #155/#157. #228 merged into #225's branch at 21:51Z. `trinity-symphony-shared` #34 CLEAN, awaiting review.
**Queue at beat close [V sql]:** `trinity_tasks` pending **0**, in flight **0**, rows with `claim_count > 0` **0**, claimed in last 24h **29**.

---

## What this beat did

Two independent adversarial verifications were commissioned on the prior beat's two unverified deliverables (rule 3 — the producer never verifies). Both came back **SEND BACK**. One of them refuted a claim I published in the Beat 44 ledger. Both send-backs were acted on in-beat; the third deliverable (the #228 follow-up) shipped as its own PR.

---

## STEP 1 — SHIPPED repid-engine **#233**: the three holes Beat 44's verification left open on the patent regret disclosure

Deliberately a separate PR from #228. Fixing them on #228 would have invalidated the verification of the exact commit that was checked — the same discipline Beat 44 applied and the reason #228 was verifiable at all.

**[X] `regretAtPrice` was published and pinned by nothing.** The three regret columns are printed in the report and quoted in the disclosure. The CLAIM test recomputed regret from a private lambda instead of reading the column it cites, so two one-line mutations survived the entire suite. Both re-run here and confirmed dead:

| mutation | before | after |
|---|---|---|
| sign flip — `overProofCostUnits - p * underProof` | 21/21 green | **8 tests fail** |
| penalty deleted — `overProofCostUnits` alone | 21/21 green | **8 tests fail** |

The fix is not only literals. The minimiser test now reads the **published column at a published price inside the band**, so the claim and the printed number are the same quantity rather than two quantities that happen to agree.

**[X] `~661` read as a measured constant. It is not.** It is `(rival over-proof cost − ours) ÷ our residual under-proof COUNT` — a step function of a small integer: ~661 at one under-proof, 330.5 at two, unbounded at zero. Pinned against synthetic results, so a later fix to `best-provider-route` fails the test and forces the figure to be restated rather than going quietly stale. The lower edge is separately shown stable and remains safe to quote.

**[X] the provenance argument led with its weakest defence.** The corpus header cited commit order first. True, but the *policy* was authored ~95 minutes before the labels, so it never established what it was cited for, and the no-import rule blocks mechanical derivation, not a human labelling with known behaviour in mind. The independent second labeller now leads — **28/30, both disagreements on scenarios whose own `why` pre-registered the call** — carrying that labeller's disclosed limit on its own method (the corpus groups by tier, so 28/30 is a *lower* bound), asserted by a test so it cannot become a false apology if someone shuffles the corpus.

**New: a standing robustness sweep.** The second-labeller result lived in a report, which decays the moment the corpus is edited. Every scenario relabelled to every other rung, one at a time, all 120 combinations — **independently reproduced here before being asserted**, and the numbers match the verifier's exactly:

```
n=120  empty bands=0  unbounded=4  ceiling cut >=25%=44
lower edge: min 28.5  median 37.857 (= the unperturbed value)  max 50.333
```

The corpus sits at the **exact median** of its own sensitivity range, not at a favourable edge. Local: 70 passed across the three affected suites; `tsc --noEmit` clean.

---

## STEP 2 — [X] SENT BACK, then SHIPPED round 3: `trinity-symphony-shared` #34 (`d27a6bb`)

The round-2 verification found **ten** mutations surviving 44/44 green. All ten now killed, re-run after the fix.

**[X] HIGH — the fix's own suite could not see the defect the PR exists to stop.** `runStaleTaskReaper`'s staleness window, status filter, batch size and survivor gate were inline literals, and the test's supabase stub implemented `select/in/lt/limit` as argument-ignoring chainables. Changing the window from one **HOUR** to one **SECOND** left every test passing — and that single edit **neutralises the entire cap**, because the reaper would rip tasks back mid-work and refund the claim before the counter could ever accumulate. That is the 365-claims-in-100-minutes runaway, reproduced by the fix for it, invisible to the fix's own tests. *A stub that discards its arguments does not test a query; it tests that a query was issued.*

**[X] HIGH — the uncapped claim paths could DRAIN the cap, not merely bypass it.** `constitutional-agent-base.js:1441/:1491` and `w3c.index.js:241` move tasks to `in_progress` without incrementing anything, and the reaper refunded them all the same: claim uncounted, reap, −1. Repeated, that walks the counter to zero and disables the cap. The refund is now conditional on `status = 'doing'` — the only status `CLAIM_SQL` sets, and `CLAIM_SQL` is the only incrementing path. Both statuses are still **released**; the rescue was never in question, only the refund. This closes the drain without reaching into a class this PR does not own.

**[X] MEDIUM — my breaker guarantee was overstated, so it is restated rather than defended.** The reaper *cannot* guarantee it never opens direct-pg's process-wide breaker: the failure counter is global and reset only by a success, so successive passes accumulate past an abandonment. What is guaranteed is that **two full failing passes stay under the threshold** — budget 3 → 2, asserted as `2 * REAP_FAILURE_BUDGET < CIRCUIT_BREAKER_THRESHOLD` with the threshold **imported from `direct-pg`** rather than copied as a literal. Lowering it there now fails the test instead of silently disarming the guard.

**[X] MEDIUM — `main()` in the recovery tool had zero coverage.** `reset(args.limit)` — un-parking task #20, the default list limit, and reporting success — survived everything. Exported and pinned end-to-end from argv.

**Mutation battery after the fix: 10/10 killed** — staleness window, status filter, survivor gate, batch size, budget 2→4, release-to-`blocked`, `claimed_by` left set, unconditional refund, crossed reset field, and direct-pg's threshold lowered underneath the guard.

---

## STEP 3 — [X] RETRACTION: repid-engine **#231** is not mergeable, and my ledger claim about it was wrong

Converted to **draft**; the full findings are posted on the PR.

- **The branch fails its own suite locally, 4/4 runs**, with a varying failure set. `DEFAULT_REGEX_BUDGET_MS = 250` is smaller than measured worker-spawn cost (136–1172 ms idle box, 8 of 12 samples over 250 ms) because the deadline timer starts **before** the worker is constructed. Raising the default to 3000 turns it green — which identifies the defect precisely: the budget covers spawn+match when it should cover the match.
- **This contradicts the green `test` check on the PR**, and that contradiction is itself the finding: the failure is timing-dependent and CI landed on the good side of it. A bound that passes in CI and fails on an idle developer box is not a bound. It is also the second time this beat family has had a timing assertion loosened after a load-induced failure.
- **The termination guarantee is unpinned.** `activeWorkerCount()` is module-private state read by a test of the same module — a proxy, not an observation. Two mutations leave a genuinely unterminated thread burning a core with the suite **10/10 green**, and one of them is verbatim the mutant the source comment says the counter exists to catch.
- **`toBe(before)` instead of `toBe(0)`** on the leak test: passes on a leaked result, and was observed **failing on a clean one**.
- **A timeout emits `rejected`/`assertion_failed`** — identical to a genuine agent failure — while the source comment, the test title, and the parallel heuristic path all say `unclear`/`unverified`. An operator's pathological pattern should not cost the agent a rejection.

**Retracted: "11 mutations, 10 killed; the survivor is equivalent" (Beat 44).** Measured against a baseline that is not green, so the score is meaningless, and two non-equivalent survivors exist. Reworking as one change rather than patching piecemeal — the last two send-backs each found a hole *inside* the fix for the previous one.

What stands and is worth keeping: the worker-thread mechanism is sound (`terminate()` interrupts a runaway V8 regex in ~120 ms, probed), `eval: true` correctly sidesteps the ts-node/`dist` path problem, `env: {}` hardening is right, the single call site never reaches `approved` on timeout, and the test that pins the heuristic's blind spot is correct and must survive the rework.

---

## STEP 4 — NO T12 DISPATCH. **Sixth beat of the hold, and it is now the most expensive thing in the loop.**

`trinity_tasks` 0 pending / 0 in flight / 0 rows above `claim_count` 0 [V sql]. The cap code is not deployed (`claim_count` is 0 everywhere), so any dispatch runs under the **old uncapped behaviour** — which is what the hold is for. Six beats of an idle free fleet is a real cost under rule 1, recorded rather than quietly repeated. It ends when #34 merges, and #34 now needs a third independent verification before it can be called ready.

---

## MISTAKES / process notes

- **A mutation that fails to apply is not a result in either direction.** My first `sed` for the crossed-reset-field mutant never matched, and the run reported zero failures — which reads as SURVIVED. Caught only by re-checking the pattern; re-run properly, it dies. Mutation runs must assert the edit landed before believing the score.
- **The weaker-property count is now eight in eight beats**, and this beat found two more: `activeWorkerCount()` (a module-internal proxy standing in for an external fact) and the reaper stub (arguments accepted and discarded). **None of the eight has ever been found by reading.** All by mutation; seven of eight by someone who did not write the code.
- **A parallel verifier switched the shared working tree's branch out from under me mid-edit.** Recovered by moving my own work into an isolated worktree that already had `node_modules` — never junctioning it, which would make `git worktree remove --force` delete the real one. Two agents in one working tree is the contamination hazard, not the worktree itself.
- I told Sean last beat that #231 closed an eight-beat item. It did not; it is drafted and reworking.

---

## Open for Sean (rule-4)

1. **`trinity-symphony-shared` #34 — this is the one that unblocks the free fleet.** Round 3 is pushed and CI-green; six beats of T12 idle time end when it merges. It still owes a third independent verification (queued as next beat's first item) before I would call it ready. Your standing design question from last beat is unchanged: should an exhausted task get its own terminal status rather than sitting in `pending`?
2. **repid-engine #225 (Patent #2 keystone) is CLEAN and based on `main`.** #233 (the measured-regret follow-up above) and the merged #228 are stacked behind it, so **#225 landing releases the whole patent stack**. Neither stacked PR can be armed for auto-merge while based on a feature branch.
3. **Carried unchanged:** Patent #1 RTP gap (c) — one real Base Sepolia anchor via `npx tsx scripts/demo/proof-carrying-e2e.ts --live` with the funded attester (a hard line for this loop) · #216 needs conflict resolution · branch protection requires only `test`, so `crosscheck`/`gitleaks` can fail and a PR still lands · `PROOF_ENQUEUE_HAL_MODE=enforce` · the public 500 on `GET /api/v1/marketplace/browse` · the dead `jest` key in `package.json`.

## Next beat

1. **Third independent verification of `trinity-symphony-shared` #34** — it gates the fleet, and the last two rounds each found a hole inside the previous fix.
2. **Independently verify repid-engine #233**, and #225 at head (Beat 44's verification of #225 never landed a report).
3. **Rework #231 as one change**: budget the match rather than spawn+match (start the deadline on the worker's `online` event), pin termination with something the module cannot fabricate, `toBe(0)`, and reconcile the timeout verdict to `unclear`/`unverified`.
4. The **shape-keyed floor rung** — the Patent #2 increment Beat 43's measurement identified, now that `proof-tier-policy.ts` is free of in-flight work.
