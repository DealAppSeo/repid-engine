# Agent runLoop Liveness Instrumentation — SPEC ONLY

**Authored:** CC, Sprint 13 v2 (2026-05-19). Branch `diag/worker-liveness-instrumentation-2026-05-19`. **Not implemented. Not merged. Spec for Sean's review.**

## Problem (evidence-grounded)

`agent_heartbeat.status='online'` + fresh `last_ping` are written by an **independent `setInterval(…,120000)`** (`trinity-symphony-shared/lib/ConstitutionalAgentV4.js:160`, `heartbeat()` :206) that is **fully decoupled** from `runLoop()`/`runLoopLegacy()`. A hung or dead runLoop still reports `online`. The columns intended to expose loop health — `agent_heartbeat.loop_count`, `tasks_completed_session`, `tasks_failed_session`, `current_task_id`, `code_version`, `railway_service_id` — are **never written by the deployed agent** (`git grep loop_count` over main = 0 files; DB shows all 12 agents = 0/null). Result: zero observability into runLoop iteration. Staggered freeze of all 12 agents over ~17h (2026-05-16/17) was invisible to every existing signal.

## The instrumentation (to be implemented in a later code sprint)

**Single principle: the runLoop must self-report progress on a cadence that a hang interrupts.**

1. **Loop progress counter.** In `runLoop()`/`runLoopLegacy()`, at the *top of every `while(true)` iteration*, increment an in-memory `this.loopCount` and record `this.lastLoopAt = Date.now()`.
2. **Persist on the existing heartbeat upsert.** Extend the `heartbeat()` `agent_heartbeat` upsert (currently 3 fields) to also write the already-existing columns: `loop_count`, `tasks_completed_session`, `tasks_failed_session`, `current_task_id`, `code_version` (= `this.version`), `railway_service_id` (= `process.env.RAILWAY_SERVICE_ID`). Zero schema change — columns already exist.
3. **Critical decoupling fix:** the loop-progress fields must be written **from inside the loop body**, never only from the `setInterval`. The `setInterval` heartbeat may continue to write `last_ping` (process-alive), but `loop_count`/`lastLoopAt` MUST originate in the loop so a hung loop produces a *stale `loop_count` with a fresh `last_ping`* — the exact signal currently missing.
4. **`/runloop-liveness` HTTP endpoint** (on the existing Express health server, `startHttpServer()`): returns `200` only if `Date.now() - this.lastLoopAt < N` (suggest **N = 90s**: legacy loop sleeps 30s/iter, so >3 missed iterations = hung); else `503` with `{ loop_count, last_loop_at, seconds_since_loop, status:'online' }`. Body must include `last_ping` too, to make the heartbeat-vs-loop divergence self-evident to any monitor.

## Detection rule (data layer, complements the endpoint)

`agent_heartbeat`: `status='online' AND last_ping > now()-5min AND (loop_count unchanged over the last 10min OR loop_count IS NULL)` ⇒ **FROZEN (alive-but-not-looping)**. This is precisely the Sprint-12/13 signature and is undetectable today.

## Why this catches what nothing else does

| Signal today | Detects freeze? |
|---|---|
| UptimeRobot → Express `/health` | No (Express thread independent of loop) |
| `agent_heartbeat.last_ping`/`status` | No (independent `setInterval`) |
| `agent_heartbeat.loop_count` | No (never written) |
| **proposed `/runloop-liveness` + loop_count-from-loop** | **Yes — within ~90s of onset** |

## Hard constraints honored

No code changed in this sprint. No schema change required (columns pre-exist). Spec only.
