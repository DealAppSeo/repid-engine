# XC #30 — SPIKE: Graph-Query Tool Spec (CKG pattern, no new embeddings)

**Sprint:** `sprint-2026-07-12-ecosystem` · **Lane:** graph-tool-spec (read-only)  
**Agent:** XC/grok · **Date:** 2026-07-13 · **Roadmap:** Wave-1 #30  
**Status:** COMPLETE — spec only; knob `graph_query_tool_enabled` already seeded OFF

---

## 0. Goal

Give agents a **structural** multi-hop query tool over Supabase/HyperDAG relationships so relationship questions skip document RAG.

Cited CKG claim (vendor/author-reported, **not measured on us**): ~269 tokens/query vs ~2982 standard RAG. Our job: wire structure as signal; measure later.

**Hard constraint:** do **NOT** extend the embedding-graph path (`graph_rag_match_nodes` et al.). That is the noise/cost trap flagged in the 2026-07-12 tech map.

---

## 1. Existing infra inventory [V code + REST]

### 1.1 REUSE as-is (embedding / memory graph — do not grow for CKG)

| Object | Role | Status |
|---|---|---|
| `agent_memory_nodes` / `agent_memory_edges` | Per-agent memory graph + 384-d embeddings | `migrations/2026-05-10-graph-rag-foundation.sql` |
| `graph_rag_match_nodes(agent, embedding, k, thr, types)` | Vector top-K | LIVE RPC |
| `graph_rag_touch_node(id)` | access_count++ | LIVE RPC |
| `graph_rag_retrieval_metrics` | RAG telemetry table | **0 rows** |
| `graph_rag_edge_inference_metrics` | Edge-inference ops telemetry | exists in types |
| `src/services/graph-rag/*` | TS retrieval + store | engine |

### 1.2 Claimed but **not** found as zero-arg REST RPC

| Name | Finding |
|---|---|
| `auto_lineage()` | **Not in** `database.types.ts`; REST `rpc/auto_lineage` → PGRST202. Roadmap assumed it — treat as **missing / misnamed**. Search for lineage-like views before inventing a second. Possible near-miss: `check_auto_tune_triggers` (unrelated). **Action:** CC confirm actual lineage function name on disk/DB before wrapping. |

### 1.3 Structural tables agents already need (counts 2026-07-13)

| Table | ~Rows | Structural role |
|---|---|---|
| `trinity_tasks` | 338k | Task DAG / claims / agents |
| `peer_verification_queue` | 132k | Peer verify edges |
| `repid_score_events` | 141k | Score lineage |
| `repid_zkp_proofs` | 79k | Proof artifacts |
| `service_contracts` | 165 | A2A contracts / co-sign surface |
| `agent_handoffs` | 4 | Explicit inter-agent handoffs |
| `agent_reports` | 1+ | Task report sink |
| `hyperdag_nodes` | 0 | Placeholder / empty |
| `hyperdag_edges` | **missing** | not present |
| `graph_nodes` / `graph_edges` | missing | n/a |

### 1.4 What HDM / NEXUS / engine already query (avoid dup)

| Consumer | Calls today | CKG relation |
|---|---|---|
| Graph-RAG retrieval service | `graph_rag_match_nodes`, `graph_rag_touch_node` | **Document/memory path only** — keep for unstructured |
| Peer-verify / scoring | direct table reads on `peer_verification_queue`, `repid_score_events` | Structure exists; **no multi-hop tool wrapper** |
| Receipt indexer | `hyperdag_receipts`, `trinity_receipt_validators` | On-chain receipt domain (cold) |
| Dispatch / escalation | `autonomous_tasks`, `trinity_tasks` | Queue, not graph tool |
| Preflight scripts | existence checks on graph_rag RPCs | health only |

**Gap:** agents that need “who co-signed X in 30d” or “proof lineage for task N” currently either (a) dump wide SQL via ad-hoc service_role, (b) RAG over docs, or (c) fail. No first-class **shape-routed** tool.

---

## 2. CKG design principles

1. **Structure is the signal** — return rows/IDs/edges, not prose chunks.  
2. **Bounded hops** — default max_depth=2, hard max=4; max_rows=50.  
3. **Allowlisted predicates only** — no free-form SQL from the model.  
4. **Read-only** RPCs (`SECURITY INVOKER` or carefully locked `DEFINER` with fixed plans).  
5. **Shape routing at dispatcher** — relationship intent → graph tool; document intent → RAG.  
6. **No new embeddings** in this workstream.  
7. **Token budget** — tool response schema designed for <500 tokens typical; truncate with `truncated=true` + cursor.  
8. **Provenance** — every edge returns `source_table` + primary key so audits can re-query.

---

## 3. Tool surface (agent-facing)

### 3.1 Single MCP/tool entry

```ts
// graph_query
{
  intent: 'neighbors' | 'path' | 'lineage' | 'cosigners' | 'contracts' | 'proofs' | 'tasks',
  seed: { type: SeedType; id: string },
  filters?: {
    since?: string;           // ISO
    until?: string;
    edge_types?: string[];    // allowlisted
    agent_id?: string;
    status?: string;
  },
  max_depth?: number;         // default 2
  max_rows?: number;          // default 25, max 50
  cursor?: string;            // opaque
}
```

### 3.2 Seed types (allowlist)

`agent` | `task` | `score_event` | `proof` | `contract` | `handoff` | `receipt` | `peer_claim`

### 3.3 Response shape (compact)

```json
{
  "ok": true,
  "intent": "cosigners",
  "seed": { "type": "agent", "id": "..." },
  "nodes": [{ "type": "agent", "id": "...", "label": "sophia", "attrs": { "tier": "ESTABLISHED" } }],
  "edges": [{ "from": "...", "to": "...", "type": "co_signed", "at": "2026-07-01T..", "src": "service_contracts:42" }],
  "stats": { "hops": 1, "rows": 12, "truncated": false, "latency_ms": 18 },
  "token_hint": 240
}
```

---

## 4. Structural RPCs to build (CC/GA) — not embeddings

Implement as Postgres functions + thin tool adapter. Names are proposals; prefer `graph_query_*` prefix to avoid colliding with `graph_rag_*`.

### 4.1 P0 — ship first

| RPC | Purpose | Core SQL sources |
|---|---|---|
| `graph_query_agent_cosigners(p_agent_id, p_since, p_limit)` | Agents co-signing / contracting with X in window | `service_contracts` (+ parties columns as schema confirms) |
| `graph_query_task_lineage(p_task_id, p_max_depth)` | Task → claims → peer verifies → score events → proofs | `trinity_tasks`, `peer_verification_queue`, `repid_score_events`, `repid_zkp_proofs` |
| `graph_query_proof_lineage(p_proof_id \| p_task_id)` | Proof → event → agent → anchor fields | `repid_zkp_proofs`, score events, optional EAS ids |
| `graph_query_handoff_chain(p_from_agent, p_since)` | Explicit agent handoffs | `agent_handoffs` |

### 4.2 P1 — after P0 measured

| RPC | Purpose |
|---|---|
| `graph_query_path(p_seed_a, p_seed_b, p_max_depth)` | Shortest allowlisted path between two seeds |
| `graph_query_agent_neighborhood(p_agent_id, p_window_days)` | Fan-in/out: tasks claimed, reports, scores, contracts |
| `graph_query_peer_verify_cluster(p_claim_hash \| p_task_id)` | Who verified whom on a claim |

### 4.3 Explicitly out of scope

- Extending `graph_rag_match_nodes` with hybrid ranking for multi-hop  
- Creating parallel `graph_nodes`/`graph_edges` materializations before P0 proves value  
- Writing from the tool (read-only)  
- Free-form SQL or PostgREST schema dump to the model  

---

## 5. Dispatcher shape-routing

```text
user/agent question
  → classifier (cheap SLM / rules): RELATIONSHIP | DOCUMENT | MIXED
  → RELATIONSHIP & graph_query_tool_enabled
        → graph_query tool (structural RPCs)
  → DOCUMENT
        → existing RAG / graph_rag_match_nodes path
  → MIXED
        → graph_query first (facts/IDs), then RAG only for missing prose
```

Config (already seeded OFF by Cowork):

- `graph_query_tool_enabled` (bool)  
- Future: `graph_query_max_depth`, `graph_query_max_rows`

Measure signals (roadmap):

- tokens/query vs RAG baseline on same question set  
- multi-hop accuracy (hand-labeled 30 questions)  
- p95 latency  

---

## 6. Example intents → RPC

| Natural question | Intent | RPC |
|---|---|---|
| “Which agents co-signed contracts with Hermes in 30d?” | cosigners | `graph_query_agent_cosigners` |
| “Proof lineage for task 337046” | lineage | `graph_query_task_lineage` / `proof_lineage` |
| “Who peer-verified claim X?” | peers | `graph_query_peer_verify_cluster` |
| “Path from agent A to proof P” | path | `graph_query_path` |
| “Summarize why Hermes is trusted” | DOCUMENT | **RAG**, not graph tool |

---

## 7. Schema-first implementation notes (for CC)

1. **Before DDL:** `\d service_contracts`, peer_verification_queue, repid_zkp_proofs — column names for parties, task_id, event_id differ historically; bind only after `information_schema` verify (RULE-5).  
2. **Resolve `auto_lineage`:** either find the real function or create `graph_query_task_lineage` as the canonical name and update the roadmap note.  
3. **RLS:** service_role for engine tool; no anon.  
4. **Indexes:** likely need `(created_at)`, `(agent_id, created_at)` covering indexes if not present — measure EXPLAIN before adding.  
5. **Feature flag:** tool no-ops with clear error when `graph_query_tool_enabled=false`.  

---

## 8. Acceptance criteria for build PR (gated on this spec)

- [ ] P0 RPCs land behind flag, schema-first migration logged  
- [ ] Tool adapter returns compact JSON ≤50 rows  
- [ ] Integration test: fixed seed fixture → stable edge set  
- [ ] Side-by-side token measurement vs RAG on 20 relationship questions (GA)  
- [ ] Docs: dispatcher routing table  
- [ ] Zero changes to `graph_rag_match_nodes` signature/behavior  

---

## 9. Coordination

| Lane | Owns |
|---|---|
| XC (this) | Spec + inventory |
| CC | RPC SQL + engine tool adapter |
| GA | Measurement harness + token/accuracy study |
| Sean | Flip `graph_query_tool_enabled` after spike metrics |

---

## 10. Bottom line

We already have an **embedding memory graph** (empty metrics, do not extend for multi-hop). The CKG win is a **new structural RPC family** over tasks/contracts/proofs/peer-verify/handoffs, shape-routed in the dispatcher, flag-gated, read-only. `auto_lineage` as named in the roadmap is **not** callable today — replace with explicit `graph_query_*` lineage RPCs after schema verify.
