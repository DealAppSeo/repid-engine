# S-OPTIMIZE — efficiency plan (what shipped, what's design-only, and the premise corrections)

Date: 2026-06-02. This sprint targeted "50% cost reduction." **The honest finding: the system already
runs almost entirely on free tier (~$0.0107/day across 7,089 LLM calls/24h).** There is essentially
no dollar cost to cut. The real, deliverable value is **visibility** (cost + efficiency dashboards —
shipped this sprint) and **waste-churn reduction** (mostly already done in S-QUORUM). The rest is
designed here for folding into the swarm work, not force-fit now.

## Premise corrections (verified against the live system)

| Sprint claim | Reality |
|---|---|
| "Build token counting + a cost calculator" | **Already exists.** `src/billing/pricing.ts` (`calculateCost`, per-model rates) + `src/billing/log-call.ts` (`logLlmCall` → `llm_call_log`: provider, tokens, cost_usd, latency, status, agent_id). Live: 7,324 rows. |
| "tool_call_log.metadata->>'provider'/'latency_ms'" | `tool_call_log` has **no** metadata/provider/token/cost columns. The cost ledger is **`llm_call_log`**, not `tool_call_log`. The dashboards read `llm_call_log`. |
| "50% cost reduction" | Total spend is **~$0.0107/day** (free-tier dominant). Nothing meaningful to cut; the win is visibility + not regressing onto paid tiers. |
| "637 shadow_rejects/day cost tokens for nothing" | 639 in 24h — real. But cait/EVERGREEN (the ~84% bulk) are rejected **pre-LLM** (`knownTypes` check, `ConstitutionalAgentV4.js:772`) → **no token cost**, just claim/release DB churn. Only handleable types that fail the substance gate cost tokens. |
| Free triad = groq `llama-3.1-8b`, cerebras `llama3.1-8b`, **together** | **Broken.** cerebras `llama3.1-8b` 404s (no access — key only has `zai-glm-4.7`/`gpt-oss-120b`); `together` has **no API key**. Working triad: **groq `llama-3.1-8b-instant` + cerebras `zai-glm-4.7` + fireworks `kimi-k2p5`** (verified S-QUORUM). |
| "Wire ANFIS learning" | `task_escalations` + `fn_anfis_learn_from_escalation` **exist**; the escalation→resolution feedback is the missing wire (design below). |

## Shipped this sprint (repid-engine — clean, additive, tested)

- **`GET /api/v1/costs/summary`** (`src/routes/costs.ts`) — 24h totals, free-vs-paid split, savings vs a
  frontier model, top spenders by agent/provider/task. Reads the live `llm_call_log`. 60s cache.
- **`GET /api/v1/system/efficiency`** (`src/routes/efficiency.ts`) — shadow_reject %, escalation rate,
  cost, throughput, ANFIS escalation learn-rate, from live `trinity_tasks` + `llm_call_log` +
  `task_escalations`. Every metric degrades to `null` if its source is missing (no fabricated numbers —
  `cache_hit_rate` is `null` because response caching isn't implemented).
- **`src/billing/free-providers.ts`** — `isFreeProvider`, the corrected `WORKING_FREE_PROVIDERS` triad,
  and `frontierCostEstimate` for the savings metric.

## Design-only — belongs in `trinity-symphony-shared` `ConstitutionalAgentV4.js` (the contested swarm loop, GA's in-flight T12 area). Fold these in; do not blind-merge a parallel rewrite.

### 1. Kill the waste at the source (Phase 1)
- **Consumer side is DONE** — S-QUORUM PR #25 added `CAPABILITY_FILTER` to `getNextTask` (agents stop
  claiming cait/EVERGREEN). Enable `CAPABILITY_FILTER=true` to drop the cait/EVERGREEN churn to ~0.
- **Producer side (new):** gate task *creation* behind `TASK_TYPES_ENABLED=peer_verify,system,heal`
  in whatever spawns child tasks (same file). Don't generate types no agent handles.
- **Backlog:** archive (don't delete) stale unhandleable pending tasks:
  `UPDATE trinity_tasks SET status='archived' WHERE status='pending' AND task_type IN ('cait','EVERGREEN') AND created_at < now() - interval '1 hour';`
  (Sean runs this — it mutates production swarm state.)

### 2. Free-tier peer_verify routing with BFT diversity (Phase 2)
Use the corrected `WORKING_FREE_PROVIDERS` triad. For SBFA diversity, **verify with a different
provider than answered**: `selectVerificationProvider(originalProvider)` picks a healthy free provider
≠ original. Track health (success/fail per provider, ≥70% over ≥10 calls) and skip unhealthy ones. The
HAL fact-check quorum already round-robins this triad (S-QUORUM `buildFactCheckProviders`).

### 3. ANFIS learning loop (Phase 4) — scaffolding exists
On task completion, if the task was escalated: set `task_escalations.resolution_status='resolved'` +
`resolution_provider/model/tier`, then `rpc('fn_anfis_learn_from_escalation', { p_escalation_id })`.
After ≥100 records/domain: if ≥80% resolve at Tier 1 → start at Tier 1; ≥60% at Tier 2 → skip Tier 1.
(Optional `anfis_routing_accuracy` table to track predicted-vs-actual tier.)

### 4. Batch processing (Phase 5)
Add `trinity_tasks.urgency TEXT DEFAULT 'normal' CHECK (urgency IN ('critical','normal','batch'))`.
Collect ≥3 batchable peer_verify tasks, send as ONE prompt ("Verify each; VERIFIED/REJECTED + reason"),
parse and fan results back. 5-in-1 ≈ 80% token reduction *on those calls* (note: small absolute $ given
free tier — the win is throughput/rate-limit headroom, not dollars).

### 5. Prompt compression + response cache (Phase 6)
Compress verbose verify prompts ("Please verify the following claim…" → "Verify. True/False + reason.
Claim:"); A/B 100 tasks compressed-vs-full to confirm equal accuracy before adopting. Cache verifications
keyed by `sha256(claim)`: if seen ≥3× with confidence >0.8 and a stable result, skip the LLM. This is
where `cache_hit_rate` in `/system/efficiency` becomes non-null.

### 6. Agent sleep/wake scaling (Phase 7)
`getActiveAgentCount(pending)`: <100→4, <500→8, else 12. Keep GCM/VERITAS/APM always-on; scale
SOPHIA/NEXUS/TORCH; CHESED/MEL/HDM/W3C/ORCH/SHOFET last. (Driven by the orchestrator, not individual
agents.)

### 7. Deduplication (Phase 8)
Add `trinity_tasks.description_hash TEXT` + a partial index on `(description_hash) WHERE status IN
('pending','doing')`. Before creating a task, skip if an open task with the same hash exists. This also
lights up `duplicate_task_pct` in `/system/efficiency`.

## Recommended order
1. Enable `CAPABILITY_FILTER=true` (already shipped in #25) — biggest churn cut, zero new code.
2. Deploy the dashboards (this PR) — measure the real baseline.
3. Fold 1–7 into the T12 swarm work, measuring each against `/system/efficiency`.
