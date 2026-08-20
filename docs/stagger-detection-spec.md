# Staggered-Freeze Detection — SPEC ONLY

> **PORTED 2026-08-17, UNMODIFIED, FOR PROVENANCE.** These are the 2026-05-19 diagnostic
> specs exactly as written on the unmerged branch `diag/worker-liveness-instrumentation-2026-05-19`.
> They are kept because they record WHY the instrument exists — the Sprint 13 finding that all 12
> agents froze while `status='online'` and `last_ping` stayed fresh for ~63h.
>
> **They do NOT describe what shipped.** The spec classifies a healthy agent as `loop_count > 0`
> plus a fresh ping. Measured 2026-08-17, `trinity-mel` satisfied both for the four weeks it was
> dead (19,155 loops, 0 completions, pinging throughout), so that rule is blind to a loop that
> spins rather than one that never starts. The shipped classification lives in
> `src/observability/agent-liveness.ts` (`deriveProgress`/`deriveHealth`) and treats
> live-but-producing-nothing as its own state. Read the module for current behaviour; read this
> file for the history.


**Authored:** CC, Sprint 13 v2 (2026-05-19). Branch `diag/worker-liveness-instrumentation-2026-05-19`. **Not implemented. Not merged. Spec for Sean's review.** Gemini's parallel sprint owns Supabase views/dashboards; this is the CC-side detection-logic spec only.

## Pattern to catch (confirmed in data)

trinity_tasks last-completion timestamps for the 12 agents formed a **~17h23m staggered cascade**: apm 2026-05-16 11:49 → shofet 18:06 → gcm 21:50 → orch 21:59 → w3c 22:00 → torch 22:51 → mel 05-17 00:01 → hdm 00:08 → veritas 00:17 → chesed 00:17 → sophia 05:04 → nexus 05:12. Each completed its last task cleanly, then **never claimed again**, while `agent_heartbeat.status='online'` stayed fresh for all 12 for ~63h after. "They finish a task, they just stop, … as they stop, they get stuck."

## `stagger_event_log` table — SPEC ONLY (DO NOT CREATE; Sean approves)

| Column | Type | Meaning |
|---|---|---|
| id | bigserial PK | |
| detected_at | timestamptz | detector run time |
| agent | text | agent that went silent |
| last_claim_at | timestamptz | from trinity_tasks |
| last_completion_at | timestamptz | from trinity_tasks |
| inactivity_minutes | numeric | now − last_completion_at |
| heartbeat_status | text | agent_heartbeat.status at detection |
| heartbeat_fresh | boolean | last_ping within 5 min (proves decoupling) |
| loop_count_at_detect | bigint | agent_heartbeat.loop_count (today: always 0/null — flags missing instrumentation) |
| concurrent_silent | int | # other agents also silent-but-online |
| previous_task_id | bigint | the cleanly-completed task before silence |
| detector_version | text | |

## Scheduled job (pg_cron preferred; Railway-cron fallback) — every 5 min

Logic (idempotent):
1. For each `trinity-%` agent: compute `last_completion = max(trinity_tasks.completed_at WHERE claimed_by=agent)`.
2. Candidate if: `last_completion < now()-15min` **AND** `agent_heartbeat.status='online'` **AND** `agent_heartbeat.last_ping > now()-5min` (the decoupling signature).
3. Idempotency: skip if a `stagger_event_log` row already exists with the same `(agent, last_completion_at)`.
4. Else insert one row with the snapshot above + `concurrent_silent` = count of agents simultaneously matching (2).

## Alert hook

On `stagger_event_log` INSERT → Telegram (Sean's channel per memory): one message per newly-silent agent, plus a digest if `concurrent_silent ≥ 3` (cascade in progress). This catches the **event of going silent within ≤5 min of onset**, not the 63-hour aftermath.

## Why this beats existing monitors

UptimeRobot/`/health` and `agent_heartbeat` all read process/timer liveness, which survives a frozen loop. This rule keys off **work liveness vs heartbeat liveness divergence** — the only signal that actually moved during the real incident. Pairs with `/runloop-liveness` (see `agent-runloop-liveness-spec.md`): endpoint catches a single agent fast; this job catches the staggered *cascade* and records forensics.

## Retention

`stagger_event_log` ~90-day retention, weekly-aggregate older. Spec only.

## Hard constraints honored

No table created. No code changed. No schema change. Spec only. Disclosure gate observed.
