# Beat 42 — the swarm runaway root-caused, and the prior two beats' diagnosis was wrong

**Date:** 2026-07-27 · **Author:** CC (autonomous build-loop, Beat 42) · **Repo of fix:** `DealAppSeo/trinity-symphony-shared` PR #34

## Summary

Beats 39 and 41 attributed the swarm runaway to a **claim race** — a "blind `UPDATE`" that let many agents claim the same task — and prescribed a fix accordingly. Beat 41 tagged this `[R]` rather than `[V]` precisely because it could not read the claim query from the engine repo, and flagged the counter-evidence it could not explain (task `435032` was also `shadow_reject` and stopped after one artifact).

The clone is present at `C:\Users\Cash4\repos\trinity-symphony-shared`. Reading the query **refutes the race hypothesis**, explains the counter-evidence, and points at a different defect.

## What the claim actually is

`lib/ConstitutionalAgentV4.js::getNextTask()` — since the 2026-06-19 egress fix:

```sql
UPDATE trinity_tasks SET status='doing', claimed_by=$1, claimed_at=$2, started_at=$2
 WHERE id = (SELECT id FROM trinity_tasks
              WHERE ... AND status = ANY($3) AND claimed_by IS NULL ...
              ORDER BY priority DESC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING ...
```

Single-row, conditional on `claimed_by IS NULL`, `FOR UPDATE SKIP LOCKED`, `LIMIT 1`. **This is race-safe and was never the problem.** `claimTask()` downstream is an idempotent ownership-confirm, not a second claim.

The "`shadow_reject` must be made terminal on the agent side" prescription is likewise unnecessary: `shadow_reject` is **not** in the claimable status set, so it already is terminal. That is exactly why `435032` stopped after one artifact — the counter-evidence Beat 41 honestly recorded but could not resolve.

## The real defect: unbounded re-claim

Several paths legitimately return a task to a **claimable** status with `claimed_by = NULL`:

| path | resulting status | in claimable set? | increments `claimHistory`? |
|---|---|---|---|
| `releaseTask()` — understand-fail, capability-gap | `pending` | yes | yes |
| `processTask` exception path | `pending` | yes | yes |
| escalation path (`task_escalated`) | `pending_clarification` | **yes, by design (#25)** | **no** |

The only brake was `this.claimHistory`, an **in-memory `Map`**:
- lost on restart;
- **per-agent-process** — 11 agents each had a private budget of `MAX_CLAIM_RETRIES = 3`;
- **never incremented on the escalation path at all.**

So a task that escalates can cycle forever, and even the paths that do count are counted 11 times over.

### Measured [V sql:2026-07-27], task `435029`

| signal | value |
|---|---|
| `task_processing` log events | **365** |
| artifacts produced | **239** (11 of them `# Question for Architect`, i.e. escalation artifacts) |
| distinct `creator_agent` | **11** |
| `task_escalated` events | **11** |
| `substance_gate_degraded` | 256 |
| `substance_gate_shadow_reject` | 5 |
| duration | ~1h40m, ~1 LLM call / 25s |

It terminated **by luck**: after 256 degraded (non-recorded) gate events which fall through to PASS, a gate event finally recorded, which routes to `shadow_reject` — a terminal status.

**A secondary finding worth its own decision:** because `pending_clarification` is claimable, *"escalate to a human for clarification"* is silently converted into *"hand it to another agent, forever."* The cap bounds the cost; whether escalated tasks should be re-served to the pool at all is a separate design call for Sean.

**A correction to Beat 41's own framing:** it reported the burn as "live right now, still going." That was true when written. As of this beat the last artifact on `435029` was **1h18m** earlier and the task is terminal — the burn **stopped on its own**. The defect is real and will recur on the next task that escalates; it is not currently consuming tokens.

## The fix (PR #34)

Count claims **durably, inside the claim statement**, and refuse to serve past the cap.

Counting at **claim** time rather than release time is the design decision that matters: it bounds every release path that exists today and every one added later, **without enumerating them**. The increment shares the statement that claims, so it is exact under concurrency for the same reason the claim is — there is no read-modify-write window.

- `trinity_tasks.claim_count` — additive column, **applied to prod first, deliberately** (see below)
- `CLAIM_SQL` / `buildClaimParams` / `CLAIMABLE_STATUSES` / `maxTaskClaims()` hoisted as statics, following the existing `isDeliverableTask` idiom, so the guards are testable with no DB
- `MAX_TASK_CLAIMS` env-tunable, default **12**
- `tests/claimCap.test.js` — 15 tests, wired into CI

An exhausted task stays `pending` but stops being served — **parked, not lost**; the HITL rows these cycles already generate are how a human finds it.

### Prod DDL, logged (CLAUDE_RULES r7 — single writer, look first)

```sql
ALTER TABLE public.trinity_tasks ADD COLUMN IF NOT EXISTS claim_count integer NOT NULL DEFAULT 0;
```

Applied to `qnnpjhlxljtqyigedwkb` 2026-07-27, verified present [V]. `ADD COLUMN` with a constant default is metadata-only on PG11+, so no table rewrite; `trinity_tasks` is a 26-FK hub and adding a column touches none of those constraints.

**The ordering is load-bearing, not incidental.** If the code shipped before the column, the claim query fails with `42703`, `getNextTask()` catches it and returns `null`, and **every agent goes quietly idle — an outage indistinguishable from an empty queue.** Column first, code second.

## Verification

- `node -c lib/ConstitutionalAgentV4.js` clean; all 5 CI test files pass (4 pre-existing → no regression); `claimCap.test.js` **15 passed**.
- **Mutation battery against my own suite: 12 valid mutations, all killed.** Every mutation confirmed landed by diff *before* any conclusion; originals kept outside the repo and restored by copy (never `git checkout`); zero residue confirmed by diff.

### The mutation that survived — a real hole in my own tests

**M12 — drop the cap bind from the call site while leaving the SQL intact: SURVIVED the first version of the suite.** Every SQL-text assertion still passed, because they only ever read the string. The failure mode this hides is worse than a weak cap: an unbound `$6` makes Postgres reject the statement, `getNextTask()` swallows the error and returns `null`, and the **entire fleet goes idle looking exactly like an empty queue**.

Closed by `buildClaimParams` plus a test that derives the highest `$N` in `CLAIM_SQL` and asserts the bind list length matches. Same family as Beat 41's Hole 1 and Beat 40's `verifyInclusion` finding: *a test that reads only one side of a contract cannot see the two sides drift apart.*

The mirror-vs-SQL split in the suite exists for this reason and is deliberate: the pure mirror proves the **property** (the cycle terminates), separate assertions prove the **wiring** (the live SQL still carries the same guards). A mirror that moved together with the implementation would prove nothing — which is precisely the trap Beat 41 fell into and documented.

### Mutations run

| # | mutation | verdict |
|---|---|---|
| M1 | drop cap predicate from `CLAIM_SQL` | KILLED |
| M2 | drop cap from the pure mirror | KILLED (5) |
| M3 | mirror increment becomes a no-op | KILLED (6) |
| M4 | boundary `<` → `<=` | KILLED (5) |
| M5 | drop the SQL increment | KILLED |
| M6 | NULL `claim_count` treated as exhausted | KILLED |
| M7 | `MAX_TASK_CLAIMS` env ignored | KILLED |
| M8 | SQL increments by 0 | KILLED |
| M9 | cap uses a huge literal, not the param | KILLED |
| M10 | drop `FOR UPDATE SKIP LOCKED` | KILLED |
| M11 | drop `COALESCE` (NULL rows unclaimable) | KILLED |
| M12 | cap param not passed at all | **SURVIVED → real hole → fixed** |
| M13 | `RETURNING` loses `claim_count` | KILLED |

## Mistakes this beat

- **Four of my first mutation attempts silently failed to find their target** and would have been reported as "no target" noise. Two were a genuine trap: the file uses **CRLF**, so a `,\n` pattern can never match, while a `\n\s*` pattern matches fine. The two that failed were the two aimed at the SQL — i.e. *the most important ones*. Had I not required "confirm the mutation landed by diff before concluding," a not-applied mutation would have been indistinguishable from a killed one and I would have reported stronger coverage than I had.
- I initially reasoned that the escalation path's `# Question for Architect` artifact explained the 239 artifacts. Checking the content refuted it — only 11 of 239 match. The escalation path explains the *release*, not the *volume*; the volume is one full answer per re-claim.

## Not done / carried

- **No T12 dispatch this beat**, continuing Beat 41's hold. The claimable queue is down to **4 tasks, all `pending_clarification`** — i.e. the entire remaining pool is escalated work — and `claimed_last_15m = 0`. Dispatching before the cap deploys would both risk another 200x cycle and destroy the clean before/after baseline the fix should be measured against.
- `claim_count` reads **0 on every row**, as expected: the column exists, no deployed code writes it yet. That is the metric to watch after deploy.
