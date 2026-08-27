---
name: trinity-preflight
description: >-
  Stateless session-start preflight for any Claude working in repid-engine /
  the HyperDAG Trinity stack. Fixes "different Claude, different truth": forces
  each session to declare its surface and access, choose BUILD vs ADVISE-ONLY,
  read fleet liveness from recency (never the lying status column), honor the
  claim gate + permanent fences, and end on a typed handoff instead of going idle.
when-to-use: >-
  Run this FIRST, at the start of every repid-engine / Trinity session, before
  making any factual claim about the live system, before touching code, and
  before reporting fleet or agent liveness. Re-run it if the session changes
  surface (e.g. moves from local CLI to Cowork) or regains/loses access to a
  service. It is a preflight, not a one-time setup — it caches nothing.
---

# Trinity Preflight

**The problem this fixes.** Two Claude sessions look at the same system and report
different "truth." One reads a static `status` column that says every agent is
`online`; the ping behind it is eighteen days stale. One thinks it can merge; it
can't. One quotes an F1 number with no ruler. One stops as soon as its first task
is done and leaves the loop cold. Every one of those is a *premise* bug, not a
skill bug — and premises are exactly what a preflight pins down.

This skill is **stateless**. It contains no counts, no F1 numbers, no fleet
head-count, no proof totals — those rot between sessions and are the source of the
drift. It tells you *where to look right now*, never *what you'll find*. If you
want a number, you query the live source at the moment you need it and attach its
ruler. A number written into this file would be a bug in this file.

Do the five steps in order. Do not skip step 1 because "it's obvious" — the whole
failure mode is sessions that assumed their premise instead of stating it.

---

## Step 1 — STATE your surface and access (out loud, first thing)

Before any other work, emit a short preamble that pins your premise. Fill in the
real values for *this* session; do not carry them from memory of a past one.

```
Preflight:
  Surface: <local-CC | cloud/desktop | Cowork>
  Access:  GH push=<yes|no>  Railway=<yes|no>  Supabase=<yes|no>
  Mode:    <BUILD | ADVISE-ONLY>   (decided in Step 2)
```

- **Surface** — how you're running.
  - `local-CC` — Claude Code CLI on Sean's machine, in a repo checkout or a worktree.
  - `cloud/desktop` — Claude Desktop / a hosted session; usually no local shell,
    tool access varies.
  - `Cowork` — the collaborative surface; treat as reviewer/advisor unless a push
    path is actually wired.
- **Access** — verify, do not assume. `gh auth status` for GH; a real MCP call
  (a `{projects}` GraphQL probe for Railway — a failed `whoami` on a team token is
  a *false* negative, see the team-token note); a `list_tables` / trivial
  `execute_sql SELECT 1` for Supabase. "The tool is listed" is not "the tool works."
- If you cannot verify a service, write `no`. An unverified `yes` is the drift.

---

## Step 2 — Decide BUILD vs ADVISE-ONLY

One rule: **can you push a branch?**

- **GH push = yes → BUILD.** You may write code/tests/docs on a branch, commit,
  push, and open a PR. Land whatever is branch-safe. This is the default and the
  point of the whole loop.
- **GH push = no → ADVISE-ONLY + DB.** You may *read* (Supabase, on-chain, files),
  diagnose, and write findings back to the operator — but you produce no branch.
  Do not narrate a build you cannot ship. If you have Supabase read but no push,
  your value is verified diagnosis, not code.

Never straddle: a session that "sort of" builds by pasting code into chat for a
human to apply is an ADVISE-ONLY session that mislabeled itself.

---

## Step 3 — Read fleet liveness from RECENCY only

This is the concrete "different truth" bug and it has one correct answer.

- **Source of truth: `v_agent_state`** (Supabase view, built 2026-08-27). One row
  per agent, `state` ∈ **`working` | `idle` | `wedged` | `down` | `unknown`**, each
  with an `evidence` column naming the reading that produced it. Query it and quote
  the state and its evidence; do not re-derive liveness yourself.
- **`v_fleet_truth` IS WRONG — do not use it, and do not quote a number from it.**
  Its `is_live` CASE consults `last_ping`, then `last_work_at`, then `ELSE false`,
  and **never consults the probe** — while its own `liveness_signal` column *does*,
  returning `probe_only`. Since heartbeat writes were removed (below), the first two
  branches can never fire, so it reports `is_live=false` for agents answering HTTP
  200. On 2026-08-27 that read **0 of 12 live** while the probe read **12 of 12**.
  It is one of ~36 mutually-disagreeing liveness surfaces; `v_agent_state` replaces
  it. The older reference implementation is
  [`src/observability/agent-liveness.ts`](../../../src/observability/agent-liveness.ts)
  (`deriveLiveness` → `live` / `stale` / `dead` by minutes since `last_ping`, clock
  injected so the boundary is testable).
- **NEVER report liveness from a static `status` column.** In `agent_heartbeat`
  the `status` field reads `online` on pings that are weeks stale — it is
  *structurally* incapable of reporting the failure that matters, because an agent
  that has died cannot write `status='offline'`. Any surface that emits raw
  `status` is one of the ~20 deprecated, mutually-disagreeing liveness surfaces.
  Do not add to them; do not quote them.
- **`is_live` IS THREE-VALUED. `NULL` MEANS UNKNOWN — IT DOES NOT MEAN DEAD.**
  `TRUE` = positive evidence of life inside the window. `NULL` = no signal at all.
  Read `NULL` as falsy and you have re-created the exact bug this step exists to
  stop. Check `liveness_signal` (`heartbeat` | `work` | `none`) to see which
  evidence, if any, backed the row.
  *Why this is spelled out (2026-08-11):* agent-side heartbeat writes were
  deliberately removed on 2026-07-17, so `last_ping` is starved and the view was
  reporting `is_live=false` for **all 12** trinity agents while three of them
  answered **HTTP 200** on `/health`. A session that trusted it nearly concluded the
  fleet was dead. **Absence of a signal you turned off is not evidence of absence.**
- **PROCESS liveness IS in this database — corrected 2026-08-27.** This bullet used
  to read *"PROCESS liveness is NOT in this database … only the HTTP `/health` probe
  knows, and that lives in UptimeRobot."* **That is now false and it cost a
  session:** a Claude read this line, went to triangulate liveness from six
  disagreeing views, and was about to ask the operator for an UptimeRobot API key it
  did not need. `agent_health_probes` holds the probe result **and more** — `ok`,
  `http_status`, `probed_at`, and crucially `loop_count`, `last_iteration_at`,
  `current_task_id` — refreshed every ~5 minutes for every agent, tens of thousands
  of rows deep. **Query `v_agent_state`; do not fetch UptimeRobot.**
- **The work-log signal still is not liveness.** It proves an agent *ran* (it wrote
  a row), not that it is *up*: an idle-but-healthy agent has no work signal and
  reads `NULL`. That is exactly why `v_agent_state` reads the probe's loop columns
  instead — `loop_count` advancing with `current_task_id` NULL is **`idle`**, not
  dead, and a fresh probe with a *stalled* loop is **`wedged`**, which no
  boolean-shaped surface can express.
- Freshness is a property of the read, not of this file. Query when you need the
  number, state the timestamp, and treat it as a dated snapshot the moment after.

---

## Step 4 — Honor the claim gate and the permanent fences

**Claim gate.** A public/external claim may cite **only** VERIFIED rows — code
demonstrated against the live system with a linked artifact (a run, a tx hash, a
test output). CLAIMED and BUILT never leave the building. Every accuracy number
carries its corpus hash and configuration width ("F1 = x on corpus v1 @ `hash` at
N families") or it is not a result. A measurement without its ruler is not a
result. The state machine lives in [`CLAIM_LEDGER.md`](../../../CLAIM_LEDGER.md).

**Permanent fences — never crossed without Sean, on any surface:**

- No merge to main, no npm publish, no prod deploy, no env-secret / Railway infra
  changes, no on-chain tx that spends real funds, no DNS/domain actions. These are
  the five live-state gates: stop and log `BLOCKED_FOR_SEAN`, do not wait idle.
- No destructive DDL and no key rotation/injection on your own authority.
- No production data as fixtures. Synthetic IDs only (`00000000-…`); the guard
  `scripts/hooks/prod-fixture-guard.js` blocks prod extracts — do not defeat it.
- Scratch files stay **out** of the repo tree (`git add -A` will stage a stray
  credential file; write scratch to the session scratchpad, not the checkout).
- This repo is **public**. State findings, not inventories: "a production key was
  committed and must be rotated" is actionable; the key value, project id, row
  counts and service names are an incident. PR bodies and commit messages are
  world-readable and permanent.

Agreement gates *judgment*; it never gates *facts*. Verify a live-state claim
against Supabase / on-chain / a real probe no matter how many models concur.

---

## Step 5 — End on a typed handoff, never idle

Finishing your task is not finishing the session. Before you stop:

1. Update [`CLAIM_LEDGER.md`](../../../CLAIM_LEDGER.md) for anything you moved to
   BUILT or VERIFIED (with the artifact).
2. Pull the **next prioritized surface** from
   [`SPRINT_BOARD.md`](../../../SPRINT_BOARD.md) (top of the ordered QUEUE — do not
   reinterpret the order) and open it, **or**
3. If the next surface is blocked on a Sean-only gate, write it as
   `BLOCKED_FOR_SEAN` with the exact missing piece (which key / which merge / which
   DDL) and pull the surface after it.

**Idle after "done" is a failure. A typed handoff is the only legal stop.** A stop
is legal when the board is genuinely empty for your surface *and* you've logged the
blockers — record that, and hand off.

---

## Sources of truth (the only three this skill points at)

| Question | Source | Path / object |
|----------|--------|---------------|
| What is each agent DOING? | **`v_agent_state`** — `working`/`idle`/`wedged`/`down`/`unknown` + `evidence`. Never a `status` column, never `v_fleet_truth` | Supabase view (2026-08-27), from `agent_health_probes` |
| What is provable vs merely asserted? | Claim ledger (CLAIMED / BUILT / VERIFIED) | [`CLAIM_LEDGER.md`](../../../CLAIM_LEDGER.md) |
| What do I work on next, in what order? | Ordered sprint queue | [`SPRINT_BOARD.md`](../../../SPRINT_BOARD.md) |

The gap between vision and provable-today lives in
[`VISION_VS_VERIFIED.md`](../../../VISION_VS_VERIFIED.md). Everything else — counts,
health, F1 — you read live and date-stamp; this skill deliberately holds none of it.
