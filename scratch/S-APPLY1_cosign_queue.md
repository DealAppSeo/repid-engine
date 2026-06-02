# S-APPLY1 — Co-Sign Backlog Prioritized Apply Order

**Date:** 2026-05-30  
**Branch:** feat/xc-s-apply1-2026-05-30 (XC isolated worktree)  
**Scope:** Design-only review of pending co-sign items. No objects applied.

## Items Under Review

1. CC's S-AUD1 migration (hash-chain / audit append logic)
2. S-SDK1 TrustShell SDK interface (3 methods)
3. S-SEC3 RLS Agent-State (74) + Sensitive OTHER triage batch

## Review Summaries

### 1. S-AUD1 (Audit Chain Append)

**Current state in checkout:** The exact `scripts/audit/S-AUD1_migration.sql` referenced by the user was not present. Existing related logic (20260423_add_hal_audit_chain*.sql and usage in pipeline/validation/substance-gate) was reviewed instead.

**Verified in existing append_hal_audit_chain:**
- Uses `pg_advisory_xact_lock(hashtext('hal_audit_chain_append'))` for concurrency control — good.
- Accepts `p_canonical_json_text` from caller (not row::text) — good (avoids serialization surprises).
- Stores event_payload as JSONB.
- For hal_production_events, callers order by id DESC for "last" (id is bigserial in the chain table; source events use UUIDs in some cases).

**Break-risks if applied (based on existing pattern):**
- High contention on the single advisory lock key if many writers (HAL events + validation + x402 + substance gate) fire concurrently — could serialize throughput.
- Caller must supply correct canonical JSON text; mismatch = broken chain on verify.
- No per-source_table locking visible (one global lock for all hal_audit_chain appends).
- UUID source_ids for some events (e.g. repid_score_events) mean ordering by (created_at, id) is required for deterministic "previous" selection — existing append function orders the chain table by id (bigserial), not source event time.
- RPC surface (append_hal_audit_chain) must be granted only to service_role.

**Rollback plan per object:**
- DROP FUNCTION IF EXISTS append_hal_audit_chain(...);
- DROP TABLE IF EXISTS hal_audit_chain;
- (Idempotent safe.)

**Recommendation:** Treat as medium-risk. Apply after critical RLS batches but before heavy public exposure. Add per-source advisory lock keys if contention observed.

### 2. S-SDK1 TrustShell SDK Interface

**Cross-reference performed** against current repid-engine (routes, services, types).

**BUILT / NEEDS_ENDPOINT / NEEDS_BACKEND matrix:**

| Method       | Primary Endpoint(s) Mapped                  | Status                  | Notes |
|--------------|---------------------------------------------|-------------------------|-------|
| score(...)   | POST /api/v1/hal/evaluate or /hal/signals  | BUILT (core)           | HAL + Comma BFT live. proofHash/sessionId may need final wiring for full audit chain. |
| verify(...)  | GET /api/v1/repid/:agentId + audit/provenance endpoints | BUILT                 | RepID + chain data exist. |
| audit(...)   | GET /api/v1/audit/chain/{sessionId} or equivalent | NEEDS_ENDPOINT / NEEDS_BACKEND | Chain storage exists (hal_audit_chain + append RPC). Full session-based "chainStatus + broken detection" walker not fully implemented in reviewed routes. |

**Break-risk:** Low for the SDK surface itself (mostly reads + existing HAL path). Highest gap is the audit() method depending on a not-yet-complete chain verification endpoint.

**Recommendation:** Implement the missing audit chain query endpoint first, then expose the SDK methods.

### 3. S-SEC3 RLS Agent-State (74) + Sensitive OTHER

**Review of scratch/S-SEC3_agent_state_74_and_other_triage_batch.sql:**

- Sensitive OTHER subset (paper_trades, governance_votes/governance_proposals, hitl_* family, *_signals, memory_* ) correctly placed in elevated class with `service_role_full` + owner policies where appropriate.
- Core 74 AGENT-STATE get `service_role_full` base (correct for internal operational tables).
- No anon-key write paths were found for these tables in src/ searches (all confirmed writes route through the service_role `db` client from config.ts).

**Break-risk:** Low. Service-role dominance for writes means enabling RLS with these policies is safe for the backend. Main risk is incomplete owner policies for user-facing tables (agent_services etc.) — already addressed in the SQL with authenticated owner clauses.

**Verification queries (post-apply):**
- Anon client: SELECT/INSERT on paper_trades, governance_votes, hitl_requests, memory_warm etc. must fail or return 0.
- Service role: full read/write succeeds.
- Rowsecurity = true for the 17+ sensitive tables in this batch.

**Rollback:** Per-table `ALTER TABLE name DISABLE ROW LEVEL SECURITY;`

## Unified Prioritized Apply Order (for Sean)

**Priority 1 (Lowest risk, highest immediate integrity impact — apply first after any outstanding critical RLS):**
- S-SEC3 Agent-State core (the 74 non-sensitive tables) + already-reviewed sensitive OTHER subset.
  - Why first: Completes RLS coverage for the bulk of operational state with minimal breakage risk (service_role writes dominate).
  - Verification: The anon-block + service_role success queries above.
  - Rollback: Per-table DISABLE.

**Priority 2 (Medium — after P1, once S-AUD1 file is provided/confirmed):**
- S-AUD1 audit chain append logic (or the existing hal_audit_chain append RPC + table if that is the current equivalent).
  - Why: Strengthens tamper-evidence for HAL events and other high-value writes.
  - Dependencies: None blocking from prior RLS.
  - Verification: Successful append via RPC from multiple writers; deterministic hash chain walk on recent hal_production_events / validation_queue etc.
  - Rollback: DROP FUNCTION + DROP TABLE (idempotent).

**Priority 3 (Higher dependency — after P2 and after missing endpoints are implemented):**
- S-SDK1 TrustShell SDK surface (the three methods + supporting audit chain query endpoint).
  - Why: Exposes the new capabilities publicly; requires the audit chain walker (P2) to be complete for the .audit() method.
  - What needs to ship first: The missing audit/chain verification endpoint and any final proofHash/sessionId wiring in the HAL path.
  - Verification: Successful calls from a test TrustShell client for score/verify/audit; rate limits and auth enforced.
  - Rollback: Remove or disable the new route handlers + SDK methods (no DB impact).

**Items needing more review before any apply:**
- Full S-AUD1 migration file (the exact one referenced was not in this checkout — review the final version for to_jsonb + advisory lock + correct ordering before P2).
- Any anon-key write paths that may exist outside src/ (direct-pg, edge functions, external services) for the S-SEC3 sensitive tables.

## Exact Rollback Commands (per batch)

- RLS table: `ALTER TABLE <name> DISABLE ROW LEVEL SECURITY;`
- S-AUD1 function/table: `DROP FUNCTION IF EXISTS append_hal_audit_chain(...); DROP TABLE IF EXISTS hal_audit_chain;`
- SDK routes: Remove/disable the new handlers in routes (no DB rollback needed).

---

**Sean apply order recommendation:** P1 (S-SEC3 agent-state) → P2 (S-AUD1 audit chain) → P3 (S-SDK1 surface) once the prerequisite endpoints exist.

All items remain gated on CC verification + Cowork co-sign per batch as previously established.