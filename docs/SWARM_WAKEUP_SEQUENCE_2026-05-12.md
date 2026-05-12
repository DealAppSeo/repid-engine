# Swarm Wake-Up Sequence — Runbook

**Date authored:** 2026-05-12
**Branch:** `feat/substrate-wakeup-and-micro-tx-loop-2026-05-12`
**Status:** SCAFFOLDING — does NOT execute. **Sean runs this tomorrow.**
**Authority:** Sean (only) flips circuit breakers and triggers trinity-* services.

---

## Scope

This is the **only** authorized procedure for transitioning the HyperDAG substrate from its current dormant state (12 trinity-* services dead since 2026-02, except occasional spokesperson activity) back to live, score-mutating operation.

**Do not deviate.** Each pre-gate exists because a past incident proved its necessity. If a pre-gate fails, **stop**. Triage with cold eyes; do not "push through" to keep the schedule.

**Per RULE-8:** the wake-up itself is Sean's lane, not CC's. CC produced the scaffolding (probes, breakers, baseline). CC will **not** run any step in this document.

---

## 11 pre-gate checks (ALL must pass before Phase A)

Run from `C:\Users\Cash4\repos\repid-engine`. Each gate is a single command + an expected result. Stop on the first failure.

### Gate 1 — Branch sanity

```powershell
git rev-parse --abbrev-ref HEAD
```

Expected: `feat/substrate-wakeup-and-micro-tx-loop-2026-05-12` (or `main` after merge).
Failure: you are on the wrong branch. `git checkout` to the right one.

### Gate 2 — Clean working tree

```powershell
git status --short
```

Expected: empty output.
Failure: there are uncommitted changes. Investigate before proceeding — wake-up against a dirty tree masks attribution.

### Gate 3 — `.env` has live Supabase credentials

```powershell
Get-Content .env | Select-String '^SUPABASE_(URL|SERVICE_ROLE_KEY)='
```

Expected: 2 lines, both non-empty values pointing at `qnnpjhlxljtqyigedwkb`.
Failure: misconfigured environment. Wake-up will write to the wrong DB.

### Gate 4 — All 6 circuit breakers in expected pre-wake state

```powershell
npm run cb:status
```

Expected (pre-wake):
- `cb_disable_x402_settlements`  TRIPPED  (settlement off until P3)
- `cb_disable_zkp_proofs`        NORMAL
- `cb_disable_onchain_writes`    TRIPPED  (anchor off until verified gas)
- `cb_disable_trade_execution`   TRIPPED  (production trades off until P3)
- `cb_disable_score_writes`      NORMAL
- `cb_freeze_swarm_responses`    NORMAL

Failure: a breaker is in an unexpected state. Reconcile via `npm run cb:resume -- <key>` or `npm run cb:kill -- <key>`. **Do not proceed with an unverified breaker state.**

### Gate 5 — Liveness probes baseline

```powershell
npm run probe:all
```

Expected: same RED/AMBER/GREEN distribution as `E:\dev\reports\2026-05-12\BASELINE_PRE_WAKEUP_2026-05-12.md`. (Phase 2 captured: GREEN=1 AMBER=5 RED=2 — confirm the two REDs are the documented swarm + x402.)
Failure: a new RED appeared since baseline. **Stop. Triage.**

### Gate 6 — Mock harness still passes

```powershell
npm run mock:scenario-01; npm run mock:scenario-03; npm run mock:scenario-04
```

Expected: all three exit 0. Skip scenario-02 (pg_net blocker, surfaced in Phase 3).
Failure: rails broke since Sprint 9 shipped. Roll back and triage before continuing.

### Gate 7 — Spokesperson UUIDs intact

```powershell
npm run capture:baseline
```

(Or query Supabase directly.) Confirm SOPHIA / VERITAS / SHOFET / CHESED rows exist with their canonical UUIDs (`f3ef0bf8...`, `a83cc9eb...`, `32e0e809...`, `2c2c24d6...`).
Failure: an agent row was corrupted/deleted. **Do not proceed.** Restore from snapshot.

### Gate 8 — Migration ledger is current

```powershell
# Via Supabase MCP
mcp__claude_ai_Supabase__list_migrations --project_id qnnpjhlxljtqyigedwkb
```

Expected: last migration is `cc_sprint_9_circuit_breakers_2026_05_12` (or later).
Failure: there are unapplied migrations from a parallel branch. Resolve before waking.

### Gate 9 — Pre-commit hook installed

```powershell
Test-Path .git\hooks\pre-commit; Get-Content .git\EXPECTED_BRANCH -ErrorAction SilentlyContinue
```

Expected: `True` + `feat/substrate-wakeup-and-micro-tx-loop-2026-05-12`.
Failure: hook is missing. Re-install per Sprint 7 procedure before any commits during wake-up.

### Gate 10 — Sean's wallet ready (only matters for Phase D+)

If Phase D (Protocol 3) is planned:
- Sean's Base Sepolia wallet has ≥ 0.05 USDC (room for 5 micro-txs at 0.01 each).
- The x402 facilitator URL is configured (`X402_FACILITATOR_URL` env var).

If Phase D is NOT planned today, skip this gate. The wake-up can stop at Phase C.

### Gate 11 — Sean confirms "GO"

This gate is **manual**. Sean reads gates 1-10, confirms each passed, then types `GO` here:

```
Sean confirms GO: _______________  (timestamp: ____________)
```

No assistant, agent, or script proceeds without this line filled.

---

## Phase A — Wake repid-engine (zero mutation)

**Goal:** boot the API server, confirm it serves health checks. No score writes happen.

1. From a fresh shell: `npm run dev`
2. Watch logs for: `Server listening on 0.0.0.0:3000` and `scoreMonitor scheduled (5-minute interval)`.
3. From another shell: `curl http://localhost:3000/healthz` → expect 200.
4. Run `npm run probe:all` again. The `probe-repid-scoring` probe should remain GREEN.
5. **Stop and confirm.** If logs show any warning, **pause** and read it. Common false alarms: `api_key_versions table not present` (harmless — it's created lazily).

**If Phase A succeeds, the API is alive but inert.** No score has moved.

---

## Phase B — Wake trinity-* spokespersons (read-only test)

**Goal:** confirm the spokesperson agents can be reached over HTTP and return a healthy response. No decisions are made.

1. Identify the trinity-* deployment URLs (Railway dashboard, AITrinitySymphony project).
2. For SOPHIA, VERITAS, SHOFET, CHESED in order:
   - `curl <trinity-url>/healthz`
   - Expect 200 with `{"status":"ok","agent":"<NAME>","version":"<X>"}` shape.
3. If any agent returns 503 (because `cb_freeze_swarm_responses` is TRIPPED) — that's expected if you tripped it pre-wake. If you didn't, **investigate**.
4. After all 4 return 200, write a single row to `trinity_agent_logs` per agent with `event_type='HEARTBEAT'` to confirm they can write upstream.
5. Probe again: `npm run probe:trinity` should flip from RED → AMBER (heartbeats are within 24h).

**If Phase B succeeds, the swarm is reachable.** No decisions have been made; no score has moved.

---

## Phase C — Protocol 1 dry run (mock pair, no settlement)

**Goal:** execute MICRO_TX Protocol 1 between two **mock** agents (not real spokespersons) end-to-end. RepID moves, but only on synthetic accounts.

1. `npm run mock:scenario-04` — confirms the agent-to-agent shape works with mocks.
2. `npm run demo:full-loop` — runs Phase 8's full-loop demo with `MOCK_FACILITATOR=true`.
3. Inspect the demo's exit log. Each of the 17 steps should report SUCCESS.
4. Run `npm run capture:post-wakeup` — compare with baseline. Expect:
   - `repid_score_events` count: +N (where N = score events from the demo)
   - `agent_memory_edges` count: +1 to +M (from graph-rag steps)
   - `hal_runner_results` count: +N
   - `trade_execution_log` count: unchanged (mock agents skip this if their decisions are REFUSED)
5. **Stop and confirm.** Read the diff. If anything looks wrong, halt.

**If Phase C succeeds, the rails are alive end-to-end.** No real-money settlement has occurred.

---

## Phase D — Protocol 1 real (SOPHIA ↔ VERITAS, no settlement)

**Goal:** repeat Protocol 1 with **real** spokesperson UUIDs, no x402 settlement.

**Pre-condition:** Phase C succeeded. Sean re-confirms `GO`.

1. Flip `cb_freeze_swarm_responses` OFF if it was on:
   ```powershell
   npm run cb:resume -- cb_freeze_swarm_responses
   ```
2. Submit a question from VERITAS to SOPHIA via the live API endpoint (use `curl` or Postman).
3. Watch logs: HAL pipeline classifies, ANFIS routes, SOPHIA drafts response.
4. Watch `repid_score_events` for the two expected rows (+5 for SOPHIA, +1 for VERITAS).
5. Watch `agent_memory_edges` for the `response_to` edge.
6. Run `npm run capture:post-wakeup`. The diff vs baseline should show exactly:
   - 2 new score events
   - 1 new memory edge
   - 1 new hal_runner_results row
   - 0 new trade_execution_log rows
   - 0 new x402 settlements

**If Phase D succeeds, the substrate is officially alive with real agents.** No money has moved.

---

## Phase E — Protocol 3 (gated, deferred)

**Goal:** SBFA-BFT consensus with x402 settlement.

**Sean's lane.** Do NOT proceed without:
- All of Phase A-D succeeded same-day
- Sean confirms Base Sepolia wallet has gas + USDC
- The pg_net blocker (Sprint 9 Phase 3 finding) is resolved — either pg_net is installed OR the trade_execution_log alert trigger is patched
- A separate "GO" confirmation specifically for Phase E

When ready:
1. `npm run cb:resume -- cb_disable_x402_settlements`
2. `npm run cb:resume -- cb_disable_trade_execution`
3. `npm run cb:resume -- cb_disable_onchain_writes`
4. Submit the SBFA-BFT decision query with x402 payment header.
5. Watch the 9 steps in MICRO_TX_PROTOCOLS Protocol 3.
6. Capture post-wakeup. Expect: 3 sbfa_bft_votes rows, 1 trade_execution_log row, 3 score events, 1 x402 settlement, 1 queued ZKP proof.

---

## Abort procedure (any phase)

If anything looks wrong at any phase:

1. **Stop typing commands immediately.** Take a screenshot of the state.
2. Trip all 6 circuit breakers:
   ```powershell
   foreach ($k in 'cb_disable_x402_settlements','cb_disable_zkp_proofs','cb_disable_onchain_writes','cb_disable_trade_execution','cb_disable_score_writes','cb_freeze_swarm_responses') {
     npm run cb:kill -- $k
   }
   ```
3. Re-run `npm run capture:post-wakeup` to capture the bad state.
4. Investigate the screenshot, the post-wakeup capture, and the relevant logs.
5. Do NOT re-attempt the same phase the same day. Re-baseline tomorrow with a fresh probe run.

---

## What CC will NOT do during wake-up

- CC will not run any step in this document.
- CC will not flip any circuit breaker.
- CC will not invoke any trinity-* service.
- CC will not write to any production table.
- CC may read state when asked (probes, baselines, captures).
- CC may help triage failed gates by reading logs.

**This is the line. Sean draws it.**

---

## Why this is HIGH STAKES

This is the first time the substrate has been intentionally woken since the 2026-02 quiescence. Mistakes at wake-up time create attribution problems that are very expensive to undo:

- A premature on-chain write anchors bad state into ERC-8004 Reputation. That's permanent.
- A premature x402 settlement spends real USDC on a broken protocol. That's permanent.
- A bad score event mutates `current_repid` on a real spokesperson. The `repid_score_events` audit log shows it forever.

The runbook is paranoid by design. Trust the gates.
