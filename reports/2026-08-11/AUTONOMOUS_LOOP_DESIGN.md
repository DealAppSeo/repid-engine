# Autonomous loop design — getting to 2–3 exchanges per day

**Status:** design, nothing built. Written 2026-08-11 during the E2E MVP packaging session.
**Verified live at time of writing:** `v_agent_preflight` → `verdict=HOLD`, `global_pause=true`,
`agents_live_10m=0` of 12, `orphaned_claims=23113`, `open_sean_gates=15`.

---

## The goal, restated

Sean engages 2–3 times a day, ideally from mobile. Each exchange sets or confirms direction.
Claude distils that into loops for XC / GA / T12. Each agent reports back on completion,
completion is verified, and the next loop is assigned — running until the daily token budget
is gone.

## Why it has not happened

Not architecture. Most of the substrate exists: `trinity_tasks`, a claim protocol with lease
expiry, `v_brain_bootstrap` as a state view, `v_fleet_truth` as the liveness answer. The
blocker is that **the fleet is halted and cannot be restarted safely yet**:

| Task | Pri | Blocks |
|---|---|---|
| #57 | 99 | Supabase `service_role` JWT + Railway tokens are in public git history, unrotated |
| #35 | 98 | Pre-demo decisions |
| #59 | 97 | All 12 agents frozen since 2026-07-17 22:18Z; needs a runtime restart |
| #55 | 94 | GitHub + Railway reach for autonomous sessions — 14 of 17 fleet tasks blocked on it |

**#57 is the real one.** Restarting 12 agents that authenticate with credentials anyone can
read off GitHub is worse than leaving them down. Everything else queues behind it.

### One recorded blocker is now stale

A settled fact says GitHub *write* from cloud is blocked by the managed proxy (task #33).
This session pushed six commits and opened/updated PR #409 from a cloud container on
2026-08-10/11. **Cloud GitHub write works.** Re-test #55 rather than inheriting its premise.

---

## The reframe: you do not need the Trinity fleet for this

The fleet is one implementation of "something runs work while Sean sleeps". Claude Code
Remote already ships two mechanisms that need no fleet, no VPS, and no credential rotation:

### Layer 1 — Scheduled triggers (unattended, no fleet)

A cron-bound trigger fires into a **fresh cloud session** on a schedule, with a standalone
prompt. That is genuine unattended execution today. Properties that matter:

- Each firing is a clean context — no drift across days.
- The prompt must be self-contained, because nothing is remembered. That is a feature: it
  forces the loop definition to live in the database rather than in a conversation.
- It costs tokens on every firing whether or not there is work. Gate the first step on
  "is there anything to do", and exit cheaply when there is not.

### Layer 2 — In-session subagents (parallelism, same turn)

Within one session, work can fan out across parallel subagents. Today's route audit was
sequential; it did not need to be. Good fan-out shapes here:

- one agent per router file for an audit sweep
- one per finding for adversarial verification
- one per hypothesis when diagnosing

Not used at all in this session — worth knowing that the single-threading you have been
watching was a constraint of instruction, not capability.

### Layer 3 — The Trinity fleet (later)

Once #57 and #59 land, the fleet becomes a throughput multiplier on top of layers 1–2, not a
prerequisite for them.

---

## The part that needs real design: verification

> "each of them prompt you back after they completed a loop (at least three times to verify
> it was all completed)"

Running the same self-report three times does not verify anything. LESSONS #1: an agent asked
for what it has no instrument to obtain returns a **plausible answer**, not a failure. Three
plausible answers are not evidence; they are three of the same guess.

This session is the argument. Every real finding came from an instrument, not an opinion:

- The terminal-injection hole was found by a hostile server, not by reading the code.
- The `--json` truncation was found by a fuzzer on its first run, not by review.
- The 500-on-public-input was proven by running the failing query against Postgres.
- The fence that "passed" three times had never reached the server at all.
- A probe that reported success had never applied its own patch.

**Rule: a loop is complete when a machine-checked artefact says so.** Acceptable evidence:

| Evidence | Why it counts |
|---|---|
| A test that was red and is now green | Reproducible by anyone, including the next agent |
| A row count that moved in a named table | Checkable after the fact, cannot be narrated |
| A CI run id with `conclusion: success` | Produced by a system with no stake in the answer |
| A commit SHA present on the branch | Existence is not a matter of opinion |

Never acceptable: "I completed the loop", a summary, a self-assessed confidence score, or a
count of steps performed.

**And every check must be able to fail.** Three times this session a check passed for the
wrong reason. Any verification query added to this loop should be probed by breaking the
thing it watches, exactly once, before it is trusted.

---

## Proposed loop shape

```
  Sean (2–3×/day, mobile)
        │  sets or confirms direction
        ▼
  DIRECTION  →  written to a table, not a chat message
        │
        ▼
  DISPATCH (scheduled trigger, e.g. every 2h)
        │  1. read v_agent_preflight — HOLD ⇒ exit cheap, no tokens burned
        │  2. read the direction row + open work
        │  3. pick the next unblocked item
        │  4. fan out subagents for the parts that parallelise
        ▼
  VERIFY (same run, before anything is marked done)
        │  run the item's own success query / test
        │  green ⇒ mark complete, record the artefact
        │  red   ⇒ leave open, record why, do not retry blindly
        ▼
  REPORT  →  one row Sean can read on a phone in 15 seconds
```

Two properties worth insisting on:

1. **Exit cheap when paused.** Step 1 costs almost nothing and returns immediately while
   `global_pause=true`. The loop can be armed *before* the fleet is fixed and simply idle.
2. **The direction lives in a row, not a conversation.** That is what makes a fresh session
   per firing viable, and what makes mobile realistic — you are editing one field, not
   re-explaining context.

---

## Budget

"Until we are out of free tokens each day" needs a floor, not just a ceiling: a loop that
burns the day's budget by 09:00 leaves nothing for the 2–3 exchanges that actually steer it.
Suggested split — reserve ~30% for interactive turns, cap autonomous firings at the rest, and
have the dispatch step check remaining budget before fanning out.

---

## Recommended order

1. **#57** — rotate the leaked credentials. Everything else is tooling around a stopped
   engine, and the engine is stopped for a good reason.
2. **Re-test #55** — cloud GitHub write demonstrably works now; the recorded blocker is stale.
3. **Arm the dispatch trigger while still paused** — it will idle cheaply and prove the
   plumbing before it has any power to do damage.
4. **#59** — restart the fleet, once 1 is done.
5. Only then: Langfuse for traces, CodeGraph for retrieval, Playwright for UI loops.

---

*Nothing in this document has been built. It is a design to argue with, and the numbers at
the top were read live from `v_agent_preflight` on 2026-08-11.*
