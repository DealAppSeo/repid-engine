# S-PUB0: Public Surfaces Backend API/SDK Contracts

**Date:** 2026-05-30  
**XC Design-Only Audit**  
**4 Repos Audited:** trustshell, trustshell-app, trustrepid, trusttrader (under C:\Users\Cash4\repos\)  
**Goal:** Define the exact backend contracts each site needs (built in repid-engine / trust services vs stubbed). This unblocks the public-surfaces track (S-PUB0+).

**Methodology (read-only):** Directory + code pattern inspection (Next.js / app / lib / components / contracts / hooks). Looked for fetch/axios calls, env URLs, SDK imports, HAL/RepID/x402/marketplace usage.

---

## Overall Architecture Note
- Backend core: repid-engine (HAL, RepID scoring, agents, x402, verification).
- Trust layer: trust services (trustshell for reputation shell, trustrepid for RepID focus, trusttrader for reputation-gated trading).
- Public sites are mostly frontend consumers. They need stable, documented APIs (REST + possibly SDKs) with clear auth (JWT for users/agents, API keys for services).

**Common needs across all 4:**
- Agent identity & RepID lookup
- HAL evaluation / signals (for trust scoring)
- x402 / settlement status
- Agent cards / discovery
- Auth / key management

---

## 1. trustshell (main trust/reputation shell)

**Type:** Full-featured reputation dashboard / shell.

**Key observed/required contracts (from lib/, components/, app/):**
- GET /api/v1/agents/:id or /agents/by-name — agent profile + current RepID + tier.
- POST /api/v1/hal/signals or /hal/evaluate — submit prompt/answer for HAL scoring + signals.
- GET /api/v1/agents/:id/card — SVG or JSON reputation card.
- x402 related: settlement status, payment requirements.
- Agent services / marketplace discovery.

**Built vs Stubbed status (as of audit):**
- HAL core: Built in repid-engine.
- RepID lookup: Built.
- Full reputation dashboard aggregation: Partially stubbed (needs backend rollups or views).
- Recommended SDK: JS/TS client for "TrustShell" that wraps the above + auth.

**Exact contract needed (minimal stable set):**
- Agent Read (public + authenticated)
- HAL Evaluate (with provider routing)
- Reputation Card / Explain (S-REP3 view)
- x402 Facilitator hooks (if payments involved)

---

## 2. trustshell-app (app variant / mobile-friendly)

**Type:** Companion app to trustshell.

**Similar needs to trustshell, plus:**
- Push / notification endpoints (if any).
- Lighter payloads for mobile.

**Built vs Stubbed:**
- Same core as trustshell.
- May need dedicated lightweight endpoints or GraphQL if not already.

**Contract recommendation:** Same as trustshell + optional "lite" variants.

---

## 3. trustrepid (RepID-focused public surface)

**Type:** RepID-centric explorer / dashboard.

**Key needs:**
- Deep RepID history / explainability (S-REP3 "why did my RepID change" view — critical).
- RepID scoring details, deltas, HAL events.
- Agent RepID leaderboards / comparisons.
- ZKP proofs for RepID (if on-chain).

**Built vs Stubbed:**
- Core RepID data: Built in repid-engine.
- Explainability view: Proposed in S-REP3 (not yet created in DB).
- Historical rollups / leaderboards: May need new backend queries or materialized views.

**Exact contract needed:**
- GET /api/v1/reputation/explain?agent_id=...&from=...&to=... (the S-REP3 function/view)
- RepID delta timeline
- Current + peak RepID + tier for any agent

---

## 4. trusttrader (reputation-gated trading)

**Type:** Trading interface with reputation requirements (hooks, contracts, scripts present).

**Key observed/required contracts:**
- Reputation gate checks before trades (RepID + tier + authority).
- x402 / settlement for trades.
- Agent reputation in trade context (e.g. counterparty trust score).
- Possibly peer verification / dispute flows.

**Built vs Stubbed:**
- RepID gate: Built (via repid-engine).
- x402 settlement: Built.
- Advanced "trust score for trading" aggregation: Likely stubbed or needs new endpoint.
- On-chain reputation (ERC-8004) hooks: contracts/ dir suggests partial.

**Exact contract needed:**
- POST /api/v1/reputation/check-gate (agent + required RepID/tier)
- Trade reputation snapshot (for audit)
- x402 + reputation combined flows
- Counterparty reputation lookup

---

## Recommended Backend API/SDK Contract (Unified for Public Surfaces)

**Base URL:** (to be defined, e.g. https://api.repid.engine or per service)

**Auth:**
- User/Agent: JWT (from Supabase or custom)
- Service: API key (service_role scoped or dedicated public keys)

**Core Endpoints (minimum viable for all 4 sites):**

1. Agent Profile & RepID
   - GET /v1/agents/{id or name}
   - Response: { id, name, current_repid, tier, peak_repid, erc8004_address, ... }

2. HAL / Trust Signals
   - POST /v1/hal/evaluate
   - Body: { prompt, answer, domain, certainty, providers? }
   - Response: { hal_score, hal_decision, signals, veto_class, hallucination_caught }

3. Reputation Explainability (S-REP3)
   - GET /v1/reputation/explain?agent_id=...&window=...
   - (The view we defined — must be created after Cowork co-sign)

4. x402 / Settlement Status
   - GET /v1/x402/settlements?agent_id=...
   - Relevant payment / escrow status with reputation context

5. Agent Cards / Discovery
   - GET /v1/agents/{id}/card (SVG or JSON)
   - Search / list with filters (tier, RepID, services)

**SDK Recommendation:**
- Official @trust/reputation-sdk (JS/TS) wrapping the above + auth helpers.
- Separate @trust/trading-sdk for trusttrader-specific gates.

**Stub vs Built Status Summary:**
- Core HAL + RepID + x402: Built in repid-engine.
- Explainability deep view (S-REP3): Proposed, not yet in DB.
- Advanced aggregations / trading-specific trust scores: Mostly stubbed — need backend work or materialized views.
- On-chain reputation (ERC-8004) integration: Partial (contracts exist in trusttrader).

**Next for Public Surfaces Track:**
- After S-SEC3 RLS on agent-state, the above contracts become safe to expose publicly (with RLS + proper auth).
- Prioritize S-REP3 view creation (after co-sign) as it is a dependency for trustrepid and general auditability.
- Define OpenAPI spec for the unified contract.

---

**Handoff to CC:** Please verify the contract definitions against the actual running (or stubbed) endpoints in the 4 repos. Confirm which are truly built vs stubbed in the current backend. This unblocks the S-PUB0+ public surfaces work.

All design-only, in isolated XC worktree. No changes applied.