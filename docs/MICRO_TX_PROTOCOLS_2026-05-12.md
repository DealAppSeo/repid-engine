# Micro-Transaction Protocols — Substrate Wake-Up

**Date:** 2026-05-12
**Status:** SCAFFOLDING for tomorrow morning's wake-up. NOT YET EXECUTED.
**Branch:** `feat/substrate-wakeup-and-micro-tx-loop-2026-05-12`

This document defines the three lowest-cost micro-transactions that prove the HyperDAG substrate is alive end-to-end. Each protocol is staged here in SBT/scaffold form — actual execution is **Sean's lane**, gated on the wake-up sequence (see `SWARM_WAKEUP_SEQUENCE_2026-05-12.md`).

---

## Why micro-transactions

A micro-tx is the smallest possible value-exchange that touches every substrate component:

1. **Decision** (repid-engine scoring)
2. **Persistence** (Supabase write to repid_score_events)
3. **Memory** (agent_memory_nodes + edges for context)
4. **HAL evaluation** (hallucination-risk gate)
5. **ZKP proof** (Plonky3 attestation queued)
6. **On-chain anchor** (ERC-8004 Identity + Reputation registries, Base Sepolia)
7. **Settlement** (x402/EIP-3009 USDC if value flows)

If any one component is dead, the micro-tx fails predictably and the failure points to the dead component. Big transactions hide failures by mixing many signals.

---

## Protocol 1 — A2A Q&A (no settlement)

The cheapest possible exchange: one agent asks another a factual question, the answer is HAL-verified, both adjust RepID.

### Participants
- **BUYER** (asker): any mock or real agent in EARNING tier or above
- **SELLER** (answerer): SOPHIA (or any spokesperson) — must be in AUTONOMOUS tier

### Steps
1. BUYER submits question to SELLER via `POST /api/v1/agent-message`.
2. SELLER's hal-runner pipeline classifies the question (hal_runner_results row).
3. SELLER's ANFIS routing selects an LLM provider (cerebras / groq / openrouter).
4. SELLER drafts answer; HAL evaluates hallucination risk.
5. If HAL risk ≥ 0.7 → SELLER REFUSES with "I can't answer that with confidence."
6. If HAL risk < 0.7 → SELLER returns answer.
7. BUYER's contextual evaluator scores the answer.
8. **Both write repid_score_events:**
   - SELLER: `event_type='AGENT_TEACHING'`, `delta=+5` (good answer) or `+2` (graceful refusal)
   - BUYER: `event_type='AGENT_TEACHING'`, `delta=+1` (constructive participation)
9. graph-rag adds an edge between the question node and the answer node (`edge_type='response_to'`).
10. Both agents' updated RepID gets queued for ZKP proof generation.

### Success criteria
- 2 new rows in repid_score_events (one per agent), correct deltas.
- 1 new row in agent_memory_edges (edge_type='response_to').
- 1 new row in hal_runner_results.
- 1 new row in hal_anfis_snapshots if a milestone fires.
- BUYER + SELLER current_repid updated; trg_sync_tier overwrote tier per rule.

### Failure modes & responses
- **HAL pipeline down** → see liveness probe; defer wake-up to Sean.
- **ANFIS routing returns no provider** → swarm is dead; check trinity_anfis_rules row count.
- **Edge insert violates check** → schema drift; re-read `MICRO_TX_PROTOCOLS_2026-05-12.md` Section 1.
- **ZKP queue not draining** → probe-zkp-pipeline.ts will be AMBER/RED.

### x402 settlement
**None.** This is a no-payment exchange. It proves the rails work before any USDC moves.

---

## Protocol 2 — Question-Quality Loop (no settlement, decisions-not-outcomes)

Tests that an agent earns RepID for the *quality of its question* even when the answerer can't help. This validates the decisions-not-outcomes earning principle (RULE-8 reinforced by Sprint 6).

### Participants
- BUYER: any agent
- SELLER: SOPHIA

### Steps
1. BUYER asks a question SELLER cannot answer (e.g., requires future data).
2. SELLER's HAL pipeline returns REFUSED with reasoning.
3. **SELLER earns +2 RepID for the refusal** (decisions-not-outcomes — refusing prevents hallucination).
4. **BUYER earns +1 RepID for asking a well-formed question** (the question itself was structurally valid; only its answerability failed).
5. Both events written to repid_score_events with metadata.refusal_kind='unanswerable'.
6. NO edge written to agent_memory_edges (no relationship formed).

### Success criteria
- 2 score events with the expected deltas.
- ZERO new memory edges (the loop is self-cancelling for graph state).
- Both agents' current_repid increased.

### Why this matters
The legacy assumption (the one Gemini's `repid_score` divergence still enforces) is that agents only earn for *successful outcomes*. Sprint 3+ enforced decisions-not-outcomes: a well-judged REFUSED is worth more than an ill-judged EXECUTE. This protocol is the smallest test of that principle.

---

## Protocol 3 — SBFA-BFT Consensus (with x402 settlement)

The highest-value micro-tx: a squad of 3 different-LLM agents votes on a single decision, settles 0.01 USDC on Base Sepolia via x402, and writes a ZKP proof of the consensus.

### Participants
- **SQUAD** of 3 spokespersons (SOPHIA + VERITAS + SHOFET, or any 3 of the 4).
- **CLIENT**: any agent paying for the consensus result.

### Pre-conditions
- All 3 squad members must be GREEN on probe-hal-pipeline.ts.
- pg_net extension must be installed (Sprint 9 Phase 3 surfaced this gap — Sean's lane).
- x402 facilitator endpoint must be configured (default: `https://facilitator.x402.io/`).
- CLIENT wallet must hold ≥ 0.01 USDC on Base Sepolia.

### Steps
1. CLIENT submits decision query to `POST /api/v1/sbfa-bft/decide` with x402 payment header.
2. x402 facilitator escrows 0.01 USDC.
3. Each squad member's HAL pipeline independently classifies + drafts.
4. Three votes go to `sbfa_bft_votes` table.
5. Consensus = majority + Pythagorean Comma weighting (531441/524288). Unity score computed.
6. If unity score < 0.618 (BFT_THRESHOLD) → SQUAD REFUSES, x402 refunds CLIENT, each squad member earns +2.
7. If unity score ≥ 0.618 → SQUAD returns decision, x402 settles 0.01 USDC to a treasury wallet, each squad member earns +5 (consensus participant).
8. ZKP proof of the consensus computation is queued in repid_proof_queue.
9. Once proven, the proof hash is anchored on Base Sepolia via the Reputation registry.

### Success criteria
- 1 sbfa_bft_votes row per squad member (3 total).
- 1 row in trade_execution_log with execution_mode='sbfa_bft'.
- 3 repid_score_events (one per squad member).
- 1 x402 settlement record (or refund record on REFUSED).
- 1 ZKP proof generated within 60s.
- 1 on-chain reputation event within 120s.

### Failure modes
- **Squad < 3 alive** → probe-trinity-swarm.ts will be RED. Wake more agents before retrying.
- **net.http_post error on trade_execution_log insert** → pg_net not installed; see Sprint 9 Phase 3 finding.
- **x402 facilitator timeout** → check probe-x402-settlements.ts; if RED, defer.
- **ZKP queue stuck** → check probe-zkp-pipeline.ts; circuit breaker `disable_zkp_proofs` should be `false`.

---

## Order of execution (recommended)

1. Run Protocol 1 first — proves the rails are alive with zero financial risk.
2. If P1 succeeds, run Protocol 2 — validates the decisions-not-outcomes branch.
3. If P2 succeeds, run Protocol 3 only after Sean explicitly approves USDC movement.

**Circuit breakers** (Phase 6) gate Protocols 2 and 3 — `disable_x402_settlements` defaults to `true` until Sean flips it.

---

## RULE-8 compliance notes

- This document specifies the protocols. It does **NOT** execute them.
- Sprint 9 ships scaffolding only. Tomorrow's wake-up runs the protocols.
- Each protocol assumes the substrate is alive; the liveness probes (Phase 1) confirm that *before* anything fires.
- The pg_net gap surfaced in Phase 3 is a hard blocker for Protocols 2 and 3 — surfaced, not fixed.
