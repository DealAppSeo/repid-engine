# Beat 43 — independent verification of the claim cap (`trinity-symphony-shared` PR #34)

**Verdict: DO NOT MERGE AS-IS.** This corrects Beat 42's ask to Sean, which was "#34 needs
your merge + a deploy." The core mechanism is right; two HIGH findings and one MEDIUM must
land first. The verifier had no authorship of #34.

**Method [V]:** separate worktree at `4615fea` with its own `npm install` (no junction —
`git worktree remove --force` follows a linked `node_modules` and deletes the real one).
21 mutations, each confirmed landed by `git diff --stat` before judging, source restored
and sha256-verified after every one. Read-only SQL against `qnnpjhlxljtqyigedwkb`. All 5 CI
test files pass locally; `claimCap.test.js` 15/15 baseline.

---

## The primary question, answered: yes, the cap can strand legitimate work

Beat 42 flagged this as the highest-value second opinion. It was.

### F1 — HIGH — the stale-task reaper is a blameless, unbounded consumer of the claim budget

`lib/ConstitutionalAgentV4.js:696-749` returns any task stuck in `doing`/`in_progress` for
>60 min to `status:'pending', claimed_by:null`. It fires on **agent death or restart** —
nothing to do with the task. Under #34 each reap permanently costs one `claim_count`.

**[V SQL]** 2,408 real tasks have already been reaped ≥12 times (2,407 of them in the last
90 days; `max reap_count = 438`). Every one of them would have been permanently parked at
claim 12. The reaper writes a `task_reaped` log and **no HITL row**, so a parked-by-reaper
task produces *zero* human-visible signal. June was the pathological month; July's max is 8
— so the risk is real but currently latent, which is exactly the window to fix it in.

### F2 — HIGH — an exhausted task is unrecoverable in practice

The PR says an exhausted task is "parked, not lost," with the escalation/HITL rows as the
path a human finds it by. Each link in that chain was checked and the chain is dead:

1. The task stays `pending` / `pending_clarification`. **Nothing distinguishes "exhausted"
   from "waiting."**
2. **[V grep]** `claim_count` appears in exactly four places repo-wide — the SQL, the
   mirror, the migration, the tests. **No query, worker, cron or UI reads it**, in either
   repo.
3. **[V SQL]** `trinity_hitl_requests`: **259,432 `pending`, 1 `approved`, ever** (that one
   on 2026-02-08). The queue has never been drained.
4. Even resolving a HITL would not help: `repid-engine/src/services/hitl-callback-handler.ts:180-192`
   only updates `trinity_hitl_requests`; it never touches `trinity_tasks`.
5. The legacy escalation path (`:1949-1973`) inserts **no HITL row at all** — only a log
   line and a "Question for Architect" artifact.

Recovery therefore requires a hand-written UPDATE. That is a silent black hole.
**Cheapest fix:** give an exhausted task a distinct terminal status (`claim_exhausted`)
and/or emit one HITL row — which also removes the parked rows from the claimable scan
(see the performance note below).

### F3 — MEDIUM — every claim counts, including non-task-fault ones

In the single-shot lifecycle a *completed* task is never re-served, so counting successful
claims is harmless. The problem is blameless consumption: the reaper (F1), plus `runLoop`
STEP 1 — `claimTask()` (`:1818-1834`) swallows any transient `pgQuery` error and returns
false, and `:939-942` then continues **without releasing**, leaving the row in `doing` for
the reaper an hour later. **A flaky DB link burns the budget.** "12" is not 12 legitimate
retries; it is 12 of anything.

### F4 — MEDIUM — nothing resets `claim_count`, and the counter it replaces did

`:2015 this.claimHistory.delete(task.id)` cleared the in-memory retry count on success.
There is no durable analogue, so `claim_count` is a monotone lifetime counter that only
ever moves toward parking. The honest semantic for a cap is *consecutive unproductive
claims* — reset on `done`.

### F8 — the deploy itself is safe [V]

All 362,996 rows have `claim_count = 0`; `truly_claimable = 0`; `pending = 0`, `doing = 0`.
**No mass-parking risk on day one; the risk is entirely forward-looking.** The 4
`pending_clarification` rows have non-NULL `claimed_by`, so they already fail the
pre-existing predicate and are stranded independently of this PR.

> **One claim of the verifier's I did not adopt.** It read the "~40k backlog" in
> `STATE_OF_THE_SYSTEM` as stale on the grounds that `trinity_tasks` has no pending rows.
> That conflates two tables: the 40k figure is `repid_proof_queue`, which **[V sql:2026-07-27]
> still reads 40,557 pending this beat.** Both facts are true of their own table. Recorded
> rather than propagated.

---

## The mutation battery: 21 applied, 6 survived

### F5 — MEDIUM — the M12 fix is narrowed, not closed

Beat 42 reported closing M12 ("the SQL asserts the cap while the call site silently stops
passing it") with `buildClaimParams` plus a placeholder-vs-bind-count test. **The test pins
the helper; the call site is free to bypass it.** Three surviving variants:

- **M15** — hand-build a 5-bind array at `:1796-1797` instead of calling `buildClaimParams` → **15/15 still pass.**
- **M16** — send a de-capped copy of `CLAIM_SQL`.
- **M21** — `Object.assign(buildClaimParams(…), {5: 2147483647})`.

`ConstitutionalAgentV4.getNextTask` has **zero** coverage: `tests/getNextTask.test.js`
exercises a *different class* (`constitutional-agent-base.js`'s `ConstitutionalAgent`).
**Fix:** one test stubbing `pgQuery` that asserts `getNextTask` sent `CLAIM_SQL` and
`buildClaimParams(...)` verbatim.

Two further weaknesses in that same test, by inspection: `Math.max(...CLAIM_SQL.matchAll(/\$(\d+)/g))`
derives `highest` **from the SQL under test**, so a coordinated removal of both `$6` and the
bind passes it; and `params.every(p => p !== undefined)` is trivially satisfied.

*This is the fifth instance in six beats of a test pinning a weaker property than the
sentence it is cited to support — and this one is a fix that was reported as complete.*

### F6 — MEDIUM — the env lever is untested (M8)

Replacing `maxTaskClaims()` with `DEFAULT_MAX_TASK_CLAIMS` inside `buildClaimParams`
survives, because the test runs with `MAX_TASK_CLAIMS` unset so the two are equal. The
advertised "raise the cap without a deploy" lever — **the operator's only mitigation for
F1/F2** — is unverified end-to-end. One-line fix.

### F7 — LOW — the cap magnitude is not pinned (M19/M20)

Every test reads `maxTaskClaims()` dynamically, so 12→2 and 12→50 both pass. M14 (→100000)
died only *incidentally*, on a loop bound of 200. The suite pins the default to `(0, 200]`,
not to 12.

### F9 — LOW, partially unverified — a second, uncapped claim path exists in-tree

`constitutional-agent-base.js:1441` does a blind, non-atomic claim with no cap and no
`FOR UPDATE SKIP LOCKED`, loaded by `trinity-worker.js:135`. The 12 named agents run
`server.js` → `ConstitutionalAgentV4`, so **the fleet is capped**; whether the worker is
deployed was not verifiable within the read-only mandate.

### Killed (15 of 21)

Deleting the cap predicate, `< $6`→`<= $6`, `+1`→`+0`, dropping `COALESCE`, dropping
`claimed_by IS NULL`, dropping `claim_count` from `RETURNING`, the author's own M12,
mirror-level equivalents, `maxTaskClaims` accepting 0/negative, dropping
`pending_clarification`, mirror sort/blacklist mutations.

### False alarms, checked and cleared

Double-counting via `processTask`'s second `claimTask()` (it is an idempotent ownership
confirm); evergreen recurrence burning budget (a fresh child row is INSERTed — all 32
evergreen rows `done`/`failed`, `max(claim_count)=0`); `spawnNextStep` re-serving a row
(it INSERTs new rows).

### Schema, verified [V]

`claim_count` `integer`, `is_nullable=NO`, `default 0`, ordinal 94. Distribution: one
bucket, `claim_count=0`, n=362,996. `pg_constraint` contype='f' = 3 FKs, none referencing
`claim_count`, no index or constraint including it — the migration's "additive,
metadata-only, no FK impact" claim holds.

**Performance note (LOW):** `COALESCE(claim_count,0) < $6` is not indexable. Irrelevant at
0 claimable rows — but because parked rows **never leave the claimable status set**, an
accumulating population of high-priority capped rows would be re-scanned and discarded on
every poll by every agent, forever. An independent argument for F2's distinct terminal
status.

---

## What must change before merge

1. **F1/F2** — a distinguishable exhausted state plus a real recovery surface. Not
   hypothetical: 2,408 tasks have already been reaped ≥12 times, and the reaper parks
   blameless work with no human-visible signal.
2. **F5** — one test at the call site. The mutation Beat 42 reported as closed survives in
   three variants, and it is the fleet-wide-outage one.
3. **F6** — one line, and it protects the only operator lever that mitigates (1).

Nice-to-have: **F4** (reset on `done`), **F7** (pin the default).

## Could not verify

Whether `trinity-worker.js` runs in production (Railway tooling out of scope). `CLAIM_SQL`
executed against real Postgres under concurrency — reasoned from statement shape under the
read-only mandate, not executed.
