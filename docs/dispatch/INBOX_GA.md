# INBOX_GA — do the two unmerged scoring caps compose, or does one make the other dead code?

## Task

**Lane:** L7 MEASUREMENT — **no write scope.** Your deliverable is an analysis returned
as text. Do not claim to have created, edited or committed a file.

**Dispatch:**
```
node scripts/dispatch/run-agent.mjs --agent ga --inbox docs/dispatch/INBOX_GA.md \
  --requires reasoning,repo_read
```

---

### Why this task exists

Two pull requests are open against this repo, both unmerged, both marked do-not-merge, both
adding a bound on how large a single RepID score change may be. They were written days
apart by different authors, they land at **different chokepoints**, and **nobody has
reviewed either one or asked whether they compose.**

They are not competing proposals that someone must choose between. They may well be
complementary. But two guards on the same quantity, with different numeric limits, at
different points in the same path, is exactly the shape where one silently makes the other
unreachable — and a guard that can never fire reads as protection while providing none.

**That is the question you are answering: if both merge, what does each one actually still
do?** Not which is better. What is left of each.

---

### Facts you need, inlined

You have `reasoning` and `repo_read`. **`repo_read` is scoped to this workspace at its
current checkout.** You **cannot** check out a branch, so you cannot read either PR's diff.
Everything you need from them is inlined below; treat it as reported, not as read. Do not
claim to have read those branches, and do not invent their contents.

**The trust vocabulary — four states, and the distinctions ARE the product:**

| State | Means |
|---|---|
| `MEASURED` | A named check ran and passed. Traceable to that check. |
| `APPROXIMATE` | Measured against a documented proxy. Always carries its caveat. |
| `NOT_CHECKED` | Nobody looked. **Not** a warning, **not** a failure — an absence. |
| `FAILED` | A check ran and did not pass. |

**Exit codes:** `0` VERIFIED, `2` NOT_CHECKED, anything else FAILED.

**Canonical facts (do not re-derive, do not contradict):**
- RepID clamps to **[10, 10000]**. Tiers: `PROBATIONARY` 0–499 · `EARNING` 500–999 ·
  `ESTABLISHED` 1000–4999 · `AUTONOMOUS` 5000–7999 · `VETERAN` 8000–10000.
- `tier` is **database-derived** — a Postgres trigger overwrites it on every write to
  `current_repid`. Nothing you propose may write tier directly.
- `repid_score_events` is the append-only audit log of every score change.
- `CONSTITUTIONAL_AUDIT_ENABLED` defaults **FALSE** and is non-load-bearing: a stub that
  always passes must never steer scoring or be reported as a measurement.

**What is on the current checkout, which you CAN read:**
- `src/services/wisdom-normalize.ts` — holds `clampEventDelta` and `MAX_ABS_EVENT_DELTA`.
  Both PRs modify this file.
- `src/scoring/score-event-writer.ts` — `insertScoreEvent` is defined here, at one place.
- `src/routes/agents-external.ts` — the score-event route. Reads `impact_factor_cap`, and
  references the earn gate.
- `src/engine/repid-update.ts` — the scoring pipeline every score change is meant to flow
  through.
- `src/providers/cost-class.ts` — three states, never two, and why `unpriced` must not
  collapse into `free`. The same discipline applies to "bounded", "unbounded" and
  "not reached by this guard".

**PR A, reported (branch `fix/cc-2026-09-14-delta-reject-bound`):**
- The live backstop `MAX_ABS_EVENT_DELTA` is **9990**, and it **shrinks** an oversized delta
  to 9990 rather than refusing it. Reported as having fired **0 times in 152,306 events**
  [reported VERIFIED 2026-09-14 — you cannot re-run this].
- Adds a tighter per-event-type bound that **throws** rather than truncating. Reported
  values: default **100** (reported p99 = 42); `SERVICE_FULFILLED` **500** (observed max
  364); `VALIDATION_FAILED` **300** (250); `CHALLENGE_WIN` **150** (100).
- `GENESIS` is **exempt** (observed 1940, the genesis grant) and relies on the 9990 backstop.
- Wired **shadow-first at `insertScoreEvent`**, described as "the chokepoint GENESIS also
  flows through". It logs what it would reject; an environment flag makes it throw.

**PR B, reported (branch `feat/xc-2026-09-13-scaled-reward-cap`):**
- Adds a cap of **50** on the scaled reward, as a code constant rather than a config value.
- Applied **at the score-event route**, **before** the earn gate and **before**
  `clampEventDelta`.
- Its own red-team table reports the race hole as **open**: two sequential events each
  capped independently sum to 100. Written up as *"remaining hole, not closed"*.
- Reports that the SQL routine `get_scaled_reward` is **not** the live scoring path — live
  scoring goes through `calculateFullReward`.
- Did not flip `REPID_RUN_EARN_GATE`.

---

### Deliverables — three analyses

### 1. The composition: what is left of each guard if both merge

Work out the order of operations for a score change that travels the route path, and state
for each guard whether it can still fire.

The arithmetic to start from: PR B caps at **50** at the route, before PR A's bound is
reached at the writer. PR A's default bound is **100**, and its largest per-type bound is
**500**. Establish whether any of PR A's bounds remain reachable **on that path**, and say
plainly if the answer is that some of them cannot.

Then the part that decides whether that matters: **how much traffic actually uses that
path?** PR A calls `insertScoreEvent` "the chokepoint". Test that claim against what you can
read. `insertScoreEvent` is defined once, and roughly 29 files under `src/` name
`repid_score_events` directly — but naming it is not writing to it, and most of those are
certainly reads. **Distinguish the readers from the writers**, and state how many writers,
if any, reach the table without passing through `insertScoreEvent`.

That number is the load-bearing output of this whole task. A guard at a true chokepoint and
a guard at one of several writers are different guarantees, and the PR describes it as the
former.

Report the count as MEASURED with the method you used, or as NOT_CHECKED if you cannot
establish it — **not** as an estimate stated flat.

### 2. What neither PR closes

PR B states its own remaining hole: per-event caps do not bound a sequence of events.
Establish whether PR A closes it, and if not, say so directly — **two guards merged, and the
hole the second one named is still open** is the single most useful sentence you can write
if it is true.

Then specify what *would* close it, as a property rather than an implementation: what has to
be bounded, over what window, and at what point in the path it would have to be observed.
Name what that requires which does not exist today.

Do not design the mechanism. State the requirement and what it costs.

### 3. The shadow data, and whether anyone can read it

Both PRs are deliberately inert on merge: PR A logs instead of throwing, PR B did not flip
the earn gate. That is the right default and is not in question.

What is in question is what happens next. For each: **what would have to be observed, for
how long, before enforcement is justified** — and, critically, **is that observation
currently possible?** A guard wired shadow-first whose shadow output nobody can query is
indistinguishable from a guard nobody wired at all, and it is worse, because it looks done.

State for each PR whether the shadow signal is MEASURED, APPROXIMATE, or NOT_CHECKED as of
this checkout, and what the operator would have to do to read it.

**One constraint you must respect:** PR A's "0 times in 152,306 events" and its per-type
observed maxima are reported figures from a database query you cannot run. Do not restate
them as your own findings and do not build a conclusion that depends on them being current.
Mark them UNVERIFIED-from-here and name the query that would settle each.

---

### Acceptance criteria

- Every claim about the current checkout names the file and, where relevant, the symbol.
- Every claim about either PR is labelled as reported, not as read.
- Every status can express all four vocabulary states. No two-state booleans.
- Each finding carries **what it does NOT establish**.
- Where you are uncertain, write **UNVERIFIED** and say what would settle it.
- Name your own **open questions** explicitly rather than resolving them by assumption. An
  unresolved question stated plainly is a better deliverable than a confident wrong answer.
- If the honest answer is that the two compose cleanly and both guards remain live, say
  that. A review that confirms the design is a result, not a wasted dispatch.

### What will be rejected

- Any claim you read a file outside this workspace, or read either PR branch.
- Any invented test output, command output, or measurement. On 2026-08-05 a dispatch
  returned a review containing fabricated test results; that is the specific failure this
  lane's constraints exist to prevent. **If you did not run it, you did not run it.**
- Restating PR A's database figures as your own measurements.
- A recommendation to enforce either guard without stating its failure direction.
- A two-state (boolean) status anywhere, or anything that writes `tier`.

### Note on where this lands

`repid-engine` is a **PUBLIC** repository. State findings, not inventories. Do not include
credentials, project identifiers, row counts or service names in your output.
