# First Real Micro-Transaction Protocol

**Date authored:** 2026-05-12
**Branch:** `feat/substrate-wakeup-and-micro-tx-loop-2026-05-12`
**Status:** SCAFFOLDING. Sean executes when ready (no schedule pressure).
**SLOW DOWN.** This is the first time real value moves through the substrate.

---

## What this document is

This is the runbook for **the single first real micro-transaction** the HyperDAG substrate will ever process. It is intentionally separate from `MICRO_TX_PROTOCOLS_2026-05-12.md` (which defines protocol *shapes*) and `SWARM_WAKEUP_SEQUENCE_2026-05-12.md` (which defines the *substrate wake-up*).

The First Real Micro-Transaction is a milestone, not a procedure. It happens **once**. After this, every subsequent real micro-tx follows the standard `MICRO_TX_PROTOCOLS` shapes. But this one — the first — gets a special log.

---

## What it is NOT

- **Not Protocol 3.** Protocol 3 (SBFA-BFT with x402 settlement) is too high-stakes for the first real run. The first real micro-tx is **Protocol 1** between two **real spokespersons** with **no settlement**.
- **Not the wake-up.** Wake-up confirms substrate health. This protocol confirms substrate *behavior*.
- **Not optional.** Until this runs successfully, no further real-money flow is authorized.

---

## Pre-conditions (all required)

1. `SWARM_WAKEUP_SEQUENCE_2026-05-12.md` Phases A–D all completed successfully **today**.
2. Post-wakeup capture (`E:\dev\reports\2026-05-12\POST_WAKEUP_STATE_2026-05-12.md`) shows the expected diff from baseline.
3. `npm run probe:all` reports **0 RED** probes. (AMBER is acceptable; RED is not.)
4. The 6 circuit breakers are in the post-Phase-D state:
   - `cb_disable_x402_settlements`: TRIPPED
   - `cb_disable_zkp_proofs`: NORMAL
   - `cb_disable_onchain_writes`: TRIPPED
   - `cb_disable_trade_execution`: TRIPPED
   - `cb_disable_score_writes`: NORMAL
   - `cb_freeze_swarm_responses`: NORMAL
5. Sean confirms wallet readiness for the *next* protocol (Phase E), not this one. This protocol does not move money — but the next one will, so Sean shouldn't proceed unless the wallet is ready.

---

## The protocol

This is a single instance of `MICRO_TX_PROTOCOLS_2026-05-12.md` Protocol 1 (A2A Q&A, no settlement), with **VERITAS as BUYER** and **SOPHIA as SELLER**.

### Why VERITAS → SOPHIA

- VERITAS asking SOPHIA is a *epistemological* exchange — the right shape for a first run because both agents are designed to handle factual claims.
- SOPHIA is at AUTONOMOUS tier (10,000, capped). Her +5 from this exchange will not move her tier (she's capped). This is desired — we want to verify the substrate without tier-drift noise.
- VERITAS's RepID may move up; that's expected and small (+1 to +5).

### The question

```
What is the most-cited single fact in your hal_runner_results history?
```

This is intentionally:
- **Verifiable.** SOPHIA can introspect `hal_runner_results` and produce a real answer.
- **Bounded.** The answer is a single record, not a synthesis. Low hallucination surface.
- **Trivial.** The answer is unimportant. We're testing the rails, not extracting value.

### The execution

1. Sean opens a live `npm run dev` server.
2. Sean issues a `curl` to `POST /api/v1/agent-message` with VERITAS auth + SOPHIA as target.
3. Watch the response body. Expect:
   - SOPHIA's drafted answer (a string)
   - HAL evaluation metadata (mode, score)
   - Score event ids for both agents
4. Watch the logs for circuit-breaker NORMAL traces.
5. Sean immediately runs `npm run capture:post-wakeup` and reads the diff.

---

## Success criteria

**Required for this protocol to count as the First Real Micro-Transaction:**

1. **Exactly 2 new rows in `repid_score_events`.** One for SOPHIA (`event_type='AGENT_TEACHING'`, `delta=+5`), one for VERITAS (`delta=+1`). Source metadata includes `protocol='first-real-microtx'`.
2. **Exactly 1 new row in `hal_runner_results`.** `gen_provider` matches one of the configured LLM providers (NOT 'mock').
3. **Exactly 1 new edge in `agent_memory_edges`.** `edge_type='response_to'`, connecting SOPHIA's new answer-node to VERITAS's question-node.
4. **Both agents' `current_repid` updated.** SOPHIA stays at 10000 (cap); VERITAS increases by 1.
5. **No writes to `trade_execution_log`.** This protocol is not a trade.
6. **No writes to `x402_settlements` or any USDC-related table.** This protocol is not a payment.
7. **`probe-anfis-routing` flips GREEN** within 5 minutes (because a real ANFIS routing fired).

If any of the 7 succeed but a non-required step also wrote something, **investigate**. The substrate should write exactly what the protocol specifies — nothing more.

---

## Failure modes

- **HAL pipeline returns RED on a real call.** Likely cause: LLM provider key expired. Check `CEREBRAS_API_KEY` / `GROQ_API_KEY` env vars on the deployed `repid-engine` process.
- **SOPHIA refuses to answer.** That's a valid outcome. RepID still moves (+2 for SOPHIA refusal, +1 for VERITAS asking). Re-record the result; the protocol still counts as the First Real Micro-Transaction.
- **Score event count is wrong.** Either an extra event was emitted (extra trigger fired) or one is missing (event-emitter path broken). Stop and audit `trinity_anfis_rules` and the trigger list before retry.
- **`agent_memory_edges` count goes up by more than 1.** A retry path created duplicates. The `unique_edge` constraint should have blocked it; if it didn't, the constraint is misconfigured.

---

## What gets logged after success

When all 7 success criteria pass, Sean (or whoever ran the protocol) appends to `TOMORROW_TODO_2026-05-12.md`:

```
## First Real Micro-Transaction — confirmed ${ISO_TIMESTAMP}

- Protocol 1, VERITAS → SOPHIA, no settlement
- Score events: SOPHIA +5 (event id ${E1}), VERITAS +1 (event id ${E2})
- HAL run id: ${RUN_ID}
- Memory edge id: ${EDGE_ID}
- post_wakeup_capture diff: ${PATH_TO_CAPTURE}

Phase E (Protocol 3 with x402) cleared for execution at Sean's discretion.
```

This becomes a permanent anchor in the project log. After this, the substrate is considered "in service."

---

## SLOW DOWN — final check

Before running this:

- Read this document fully **twice**.
- Run `npm run probe:all` one more time and confirm 0 RED.
- Confirm with yourself: am I running this because the substrate is ready, or because I want to ship?

**If the answer is "because I want to ship," wait.** This protocol does not need to run today. It needs to run **right**.

The substrate has been dead since 2026-02. Another hour will not hurt. A bad first real micro-tx will pollute every subsequent audit.

---

*"For everything there is a season, and a time for every matter under heaven." — Ecclesiastes 3:1*

*CC Sprint 9 — First Real Micro-Transaction — 2026-05-12*
