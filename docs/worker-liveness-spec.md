# Worker / Cascade Liveness Instrumentation — SPEC ONLY

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


**Authored:** CC, Sprint 13 v2 (2026-05-19). Branch `diag/worker-liveness-instrumentation-2026-05-19`. **Not implemented. Not merged. Spec for Sean's review.**

## Key architectural finding (must inform any "worker liveness" design)

There is **no dedicated cascade worker** in `repid-engine`. `service_contracts` are processed only by the route `POST /api/v1/agent/process-contracts`, which is called **only** by a Trinity agent's `runLoop()` idle branch via `ServiceContractClient.processOne`. **That branch exists only in the escalation `runLoop()`, not in `runLoopLegacy()`.** Railway logs show all deployed agents print `Entering Main Task Loop (Legacy)` ⇒ `ESCALATION_CONTRACT !== 'true'` ⇒ **cascade contract processing is structurally inactive in production today**, independent of the freeze. `service_contracts` has no `claimed_at/claimed_by`; lifecycle = `created_at → escrowed_at → fulfilled_at/disputed_at → …`.

Therefore "worker liveness" = **(a)** is *any* agent runLoop reaching the cascade branch, and **(b)** is `ESCALATION_CONTRACT` enabled, and **(c)** is `REPID_API_URL`/`REPID_API_KEY` set in agent env (else `processOne` silently no-ops).

## The instrumentation (later code sprint)

1. **`/worker-liveness` endpoint (repid-engine, on the existing API service).** Returns `200` if a `service_contracts` row had a forward state transition (`escrowed_at`, `fulfilled_at`, `disputed_at`) within the last **N=15 min**; else `503` with `{ last_transition_at, minutes_since, pending_unprocessed, escalation_contract_expected:boolean }`. Single indexed query on `service_contracts(greatest(created_at,escrowed_at,fulfilled_at,disputed_at))` — keep it cheap.
2. **Surface the structural gate.** The 503 body must report whether cascade processing is even *expected* (i.e., whether the swarm is configured with `ESCALATION_CONTRACT=true`). A dormant cascade pipeline when escalation is OFF is *expected*, not an incident — the endpoint must distinguish "configured-off" from "configured-on-but-stalled" so monitoring doesn't cry wolf.
3. **Config assertion probe (recommended companion).** A lightweight startup log line + `/config-assert` that reports `ESCALATION_CONTRACT`, presence of `REPID_API_URL`/`REPID_API_KEY` (booleans, never values). Sprint-12's "zero cascades ever" is fully explained by the legacy-loop + config gate; this probe makes that visible without log spelunking.

## Detection rule (data layer)

`service_contracts`: `count(*) FILTER (status='pending' AND created_at < now()-30min) > 0 AND max(greatest(escrowed_at,fulfilled_at,disputed_at)) < now()-30min` ⇒ **cascade pipeline dormant** — qualify with the config-gate so the alert says either "stalled" or "structurally off (ESCALATION_CONTRACT unset)".

## Hard constraints honored

No code changed. No schema change. Spec only. Disclosure gate observed (no comma-math literals).
