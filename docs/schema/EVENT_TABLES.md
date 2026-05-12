# Event Tables — Canonical Split

**As of:** CC Sprint 10, 2026-05-12

The HyperDAG repid-engine has multiple event/telemetry tables. They are NOT redundant — each answers a distinct operational question. Future readers (humans and Claude sessions) should consult this doc before writing new code that touches any of them.

---

## `repid_events` — Operational Event Ledger

**Purpose:** records WHAT HAPPENED in the system: task lifecycle events, x402 settlements, peer validations, discoveries, exploration outcomes.

**Convention:** `event_type` is `lowercase_snake_case` (e.g., `task_complete`, `x402_inbound_settled`, `peer_validate`).

**Producers:** swarm code paths, x402 routes, peer-validation workers.

**Consumers:** `feedback-loop-worker.ts` reads these and may emit a downstream `repid_score_events` row as the reputation consequence.

**Key columns:**
- `event_type` — operational event identifier (constrained CHECK whitelist)
- `feedback_event_id` — FK to `repid_score_events.id` once the event has been scored; NULL means "not yet scored"
- `parent_event_id` — chain for related-event traversal (caused_by graph-RAG inference uses this)

**NOT for direct RepID scoring.** Score deltas live in `repid_score_events`.

---

## `repid_score_events` — Canonical RepID Scoring Ledger

**Purpose:** records every change to `repid_agents.current_repid` with full provenance.

**Convention:** `event_type` is `SCREAMING_SNAKE_CASE` (e.g., `CHALLENGE_WIN`, `PREDICTION_RESOLVE`, `HAL_SCORE_EVENT`).

**Producers:** `src/engine/repid-update.ts`, `src/services/repid-earning.ts`, anything that mutates `current_repid`.

**Consumers:** the BFT/ZKP proof system, badge awards, audit chains.

**Append-only.** Never UPDATE or DELETE rows here.

**Key columns:**
- `delta` / `repid_before` / `repid_after` — actual numeric movement
- `repid_delta_calculated` vs `repid_delta_applied` — pre-clamp vs post-clamp (10..10000 bounds)
- `certainty_at_claim`, `hal_score`, `mirror_test_triggered`, `eas_attestation_id` — provenance trail
- `idempotency_key` — prevents double-scoring
- `zk_proof_triggered`, `zk_proof_id` — Plonky3 ZKP attestation linkage

**As of cc_sprint_10:** the `paper_trade_outcome` lowercase outlier remains in the CHECK whitelist because `src/services/repid-earning.ts:181` actively writes it. This is a surfaced action item for rename-vs-remove decision.

---

## `graph_rag_retrieval_metrics` — RAG Retrieval Quality (Gemini Sprint 3.5)

**Purpose:** measures whether retrieving Graph RAG context improved downstream HAL signal quality. Answers: "was the retrieved context useful for the task?"

**Producers:** `src/services/graph-rag/retrieval-service.ts` (post-query telemetry hook).

**Schema:** `agent_id, query, latency_ms, nodes_retrieved, relevance_score`.

**Created by:** Gemini Sprint 3.5 on branch `feat/x402-mesh-bidirectional-2026-05-11`.

---

## `graph_rag_edge_inference_metrics` — Inference Run Telemetry (CC Sprint 10)

**Purpose:** operational telemetry on the edge INFERENCE engine itself. Answers: "how many edges did we propose, how many got persisted, how many got rejected by CHECK?"

**Producers:** `scripts/graph-rag/infer-edges.ts` writes one row per CLI invocation (dry-run or apply).

**Schema:** `run_id (UUID), agent_id, nodes_examined, edges_inferred, edges_persisted, edges_deduplicated, edges_rejected_check, edge_type_distribution (jsonb), dry_run (bool), notes`.

**Created by:** CC Sprint 10 on branch `feat/schema-canon-and-graph-rag-substrate-2026-05-12`.

---

## Why two RAG-metrics tables, not one?

Different concerns, different lifecycles:

| Concern | Table | Question answered |
|---|---|---|
| Retrieval quality | `graph_rag_retrieval_metrics` | "Did fetching this context help HAL classify?" |
| Inference health | `graph_rag_edge_inference_metrics` | "Did edge inference work? Any CHECK rejections?" |

Merging them would mix two distinct concerns. Keep them separate. Both are owned by their respective sprint authors; neither should be modified without coordination.

---

## Why two event tables (`repid_events` vs `repid_score_events`)?

`repid_events` is the OPERATIONAL log — what the swarm did.
`repid_score_events` is the SCORING log — what the consequence was for reputation.

The split exists because:
1. Not every operational event has a scoring consequence (e.g., x402 discovery events).
2. Scoring requires deterministic provenance (HAL score, certainty, attestation) that operational events don't carry.
3. The BFT/ZKP proof system needs an append-only audit trail; `repid_events` is mutable (e.g., `feedback_event_id` gets set after scoring).

Future code should write to `repid_events` for "this happened" and let `feedback-loop-worker.ts` derive the `repid_score_events` row.

---

## Naming convention enforcement

- `repid_events.event_type` → lowercase_snake_case (CHECK enforced)
- `repid_score_events.event_type` → SCREAMING_SNAKE_CASE (CHECK enforced; one historical outlier — see above)

If you're tempted to mix conventions, don't. The casing is the at-a-glance signal of which lane you're in.

---

*Authored by CC Sprint 10, 2026-05-12. Update on every new event-table addition.*
