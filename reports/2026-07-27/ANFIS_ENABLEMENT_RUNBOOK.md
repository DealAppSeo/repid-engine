# ANFIS / Broker Enablement Runbook — Patent #2 (STAGING; flips = Sean GO)

**Date:** 2026-07-27
**Branch:** `feat/cc-2026-07-27-anfis-enablement-staging`
**Status:** ARTIFACTS ONLY. Nothing in this branch is live. No flag is flipped, no env var is set, no Railway tool is called. This runbook is the *procedure* Sean runs (or approves) to turn the broker on — each step one-line-reversible.

## What "the broker" already is (no build required — verify, don't rebuild)

The Patent #2 server-side LLM broker is **already implemented and deployed** on the engine:

- `POST /api/v1/llm/complete` (`src/routes/route.ts`) — accepts a prompt + optional `agent_id`, injects the provider key **server-side**, runs ANFIS/static routing, returns a completion, and writes a cost/routing row.
- `src/auth/api-keys.ts` — `issueAgentApiKey(agentId, label, scopes)` mints a `ts_live_…` key (stored as sha256 hash only); `validateAgentApiKey` checks it; scope `llm_complete` gates the broker.
- `src/providers/router.ts` + `src/services/anfis-router.ts` — cost-ordered static chain with an ANFIS shadow recommendation. ANFIS reordering is gated by `ROUTER_STRICT_COST_ORDER` (default strict/on → ANFIS is shadow-only).

**The gap is not code — it is that the 12 Trinity agents call providers DIRECTLY** (`ConstitutionalAgentV4.js` hardcoded PROVIDERS), so zero agent traffic flows through the broker and ANFIS can't optimize their spend. Enablement = point the agents at the broker, then let ANFIS decide.

## Why this is staged, not flipped

Per STATE_OF_THE_SYSTEM + memory: enable-flag gates stay closed until measured and Sean says GO. Flipping `ENGINE_LLM_PROXY` / `ROUTER_STRICT_COST_ORDER` blind risks (a) routing all agent traffic through one path before it's proven under load, and (b) letting ANFIS reorder cost-ordered providers before the shadow numbers justify it. This runbook makes each move explicit, loud, and reversible (canon R7 "no silent failures").

---

## Pre-flip acceptance (already green on this branch)

`tests/anfis-enablement.test.ts` (5 acceptance criteria, all passing):
- (a) no-leak — completion + logs never echo a provider key / `user_paid_keys`.
- (b) server-side injection — a keyless request still completes (engine injects).
- (c) ANFIS present — response carries `router_decision` + a row hits `anfis_routing_logs`.
- (d) live-routing — `ROUTER_STRICT_COST_ORDER=false` lets an ANFIS rec reorder the pick; `=true` does not.
- (e) job-token-auth — valid `llm_complete` key → 200; missing scope → 403; shared env key targeting an agent → 403.

Run: `npx jest --config jest.config.js tests/anfis-enablement.test.ts --forceExit`

---

## The flip sequence (each step reversible in one line)

### STEP 1 — Mint per-agent broker keys (no live behavior change)

Dry-run first (writes nothing, prints no keys):
```
SUPABASE_URL=<engine url> SUPABASE_SERVICE_KEY=<engine service key> \
  npx ts-node scripts/anfis/mint-agent-keys.ts
```
Then apply (mints one `llm_complete`-scoped key per Trinity-12 agent; prints each raw key ONCE):
```
SUPABASE_URL=<...> SUPABASE_SERVICE_KEY=<...> \
  npx ts-node scripts/anfis/mint-agent-keys.ts --apply --skip-existing
```
- Keys are stored as sha256 hashes only; copy each raw key at mint time — it cannot be recovered.
- **Reverse:** `revokeAgentApiKey(keyId)` (or `UPDATE agent_api_keys SET revoked_at=now() WHERE name='anfis-broker-2026-07-27'`). Minting alone changes no routing — safe to do ahead of GO. <!-- gitleaks:allow (label, not a secret) -->
- **Measure:** `SELECT agent_id, key_prefix, scopes FROM agent_api_keys WHERE name='anfis-broker-2026-07-27' AND revoked_at IS NULL;` → expect 12 rows. <!-- gitleaks:allow (label, not a secret) -->

### STEP 2 — Point each agent at the broker (per-agent Railway env)

For each of the 12 agent services, set (Railway var — Sean-only per canon; NOT set by any tool here):
```
REPID_API_URL = https://repid-engine-production.up.railway.app
REPID_API_KEY = <that agent's minted ts_live_ key from STEP 1>
```
- **Reverse:** unset `REPID_API_KEY` (or `ENGINE_LLM_PROXY` in STEP 3) on that service; the agent falls back to its direct-provider path. Do one agent first (canary), verify, then the rest.
- **Measure:** after STEP 3 on the canary agent, `SELECT count(*) FROM anfis_routing_logs WHERE created_at > now() - interval '15 min';` should climb (agent traffic now flows through the broker).

### STEP 3 — Turn on the proxy path on the agents (`ENGINE_LLM_PROXY=true`)

Per the `ENGINE_LLM_PROXY` shared-lib change (draft path in memory: XC X1). Set on the agent service(s):
```
ENGINE_LLM_PROXY = true
```
- Start with ONE agent (e.g. `trinity-orch`) as canary. The broker still routes cost-ordered (ANFIS shadow-only) until STEP 4, so this step alone just moves traffic onto the broker without changing which provider wins.
- **Reverse:** `ENGINE_LLM_PROXY=false` (or unset) on the service → agent reverts to direct providers instantly.
- **Measure:** canary agent's LLM calls appear in `anfis_routing_logs` / `logLlmCall`; free-tier % holds; no rise in agent error rate. Compare 1h before/after on the canary before rolling to all 12.

### STEP 4 — Let ANFIS actually decide (engine: `ROUTER_STRICT_COST_ORDER=false`)

Only after STEP 3 traffic proves the broker path is healthy AND the shadow logs show ANFIS would win on cost/quality. On the **engine** service:
```
ROUTER_STRICT_COST_ORDER = false
```
- This is the single flip that lets ANFIS reorder the cost-ordered chain (proven by acceptance test (d)). Until now ANFIS was shadow-only.
- **Reverse:** `ROUTER_STRICT_COST_ORDER=true` (or unset — default is strict) → ANFIS returns to shadow-only, cost order restored. One env change.
- **Measure (the promotion gate — canon A4 "promote only where it wins"):**
  ```
  SELECT category,
         avg(cost_saved) AS avg_cost_saved,
         count(*) FILTER (WHERE cost_saved > 0) AS anfis_wins,
         count(*) AS n
  FROM anfis_routing_logs
  WHERE created_at > now() - interval '24 h'
  GROUP BY category;
  ```
  Keep `ROUTER_STRICT_COST_ORDER=false` only if `avg_cost_saved > 0` per category AND HAL quality per category does not regress vs the strict-order baseline. Otherwise revert.

---

## Rollback (all four steps, fastest → safest)

| To undo | One-line reverse |
|---|---|
| STEP 4 ANFIS decide | engine `ROUTER_STRICT_COST_ORDER=true` |
| STEP 3 proxy path | agent `ENGINE_LLM_PROXY=false` |
| STEP 2 broker target | unset agent `REPID_API_KEY` |
| STEP 1 minted keys | `UPDATE agent_api_keys SET revoked_at=now() WHERE name='anfis-broker-2026-07-27'` <!-- gitleaks:allow (label, not a secret) --> |

## Guardrails honored

- No flag flipped, no `ENGINE_LLM_PROXY` / `ROUTER_STRICT_COST_ORDER` set anywhere live by this branch.
- No Railway variable-listing tool called; no secret values in code (keys come from env / one-time mint stdout).
- Roll one canary agent through STEP 2+3 before the other 11 (blast-radius = 1).
- Every step is loud (logged) and one-line reversible (canon R7).
