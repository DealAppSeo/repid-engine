# Reponomics Demo — Phase 1 Precheck

**Date:** 2026-04-27.
**Sprint:** `repid-engine/feat/reponomics-demo-2026-04-27`,
`trustrepid/feat/reponomics-demo-2026-04-27`.
**Audit posture:** read-only.

---

## 1. Existing infrastructure

### 1.1 ANFIS-Ikigai service

Lives on `feat/anfis-ikigai-v0.1-adversarial-harmonic` (private branch,
not main). The reponomics sprint **does not depend on** ANFIS-Ikigai
directly — Wisdom and Character scores are independent simpler
formulas (Pythagorean Comma calibration for W; rule-based delta for C).
No cross-branch coupling.

### 1.2 hal_audit_chain

- **Schema** (on main, from `20260423_add_hal_audit_chain.sql`): id BIGSERIAL,
  source_table, source_id, event_payload JSONB, previous_entry_hash,
  current_entry_hash, created_at.
- **Writer** (`src/services/auditChainWriter.ts`): exposes
  `appendToAuditChain(sourceTable, sourceId, eventPayload)` returning
  `{id, current_entry_hash}`. Acquires advisory lock so concurrent
  appenders serialize.
- **Current rows:** ~11 entries (mostly threshold-proof attempts from
  the e2e demo sprint).
- **Reponomics integration:** every score update, bet placement, bet
  resolution, x402 tip delivery, and trading-round event emits via
  `appendToAuditChain` with a `source_table` and `event_type` field in
  the payload. New `emitAuditEvent({event_type, payload})` wrapper
  added in `src/services/audit-emit.ts` for ergonomic callers.

### 1.3 repid_score_events

- **Real, populated table** (806 rows) used as the existing
  earned/perceived RepID storage by the engine's `repid-update.ts`
  pipeline.
- **Reponomics integration:** linked-bet resolution writes to
  `repid_score_events` per the engine's existing pipeline, not by
  direct `repid_agents.current_repid` updates. The atomic SQL function
  `apply_linked_bet_resolution` (added in this sprint) wraps:
  - update `repid_agents.current_repid`
  - insert into `repid_score_events`
  - update `linked_bets.status='resolved'`
  in a single transaction (PL/pgSQL).

### 1.4 Two chosen fleet agents — APM and VERITAS

| Agent | id (uuid) | current_repid | tier (KYA) |
|---|---|---:|---|
| APM | `065ad782-ea58-4078-9414-60a862d67ba1` | **1240** | Silver |
| VERITAS | `a83cc9eb-43b0-49ee-9e45-2ecbb0d35067` | **3260** | Platinum |

**Important:** the spec's example math uses RepID 7000 for the
mission-aligned agent (Builder M's owned agent) and 5500 for sybil
agents. **APM's live RepID (1240) is below the 5000 floor** the
authority formula enforces. To make the demo math demonstrate the
mission-vs-wealth crossover honestly:

- The two-builder seed migration bumps APM to RepID **7000** with
  W=**1500**, C=**1700**. This is a demo-time bump on the live row,
  reversible by anyone with admin access. Documented in the migration
  notes.
- VERITAS is bumped to RepID **5500** with W=**1100**, C=**1100** to
  serve as a credible trade counterparty.
- Builder W's five sybil agents are NEW rows
  (`builder_w_sybil_{1..5}`) with RepID **5500**, W=**900**, C=**600**.

This makes the crossover narrative reproducible — running the demo,
Sean and Marco see Builder M ($50 stake) outperform Builder W ($1000
stake) because the sybil cohort decays.

### 1.5 Existing x402 dependencies

**None.** `package.json` does not include any x402 client/server
package. Per the sprint rules ("DO NOT add new external dependencies
without documenting why"), I implement HTTP 402 directly without an
x402-rs library — the protocol is just a 402 response with an
`accepts` array per the Coinbase spec. Real on-chain settlement
verification is gated behind `X402_REAL_RPC=true` (default false ⇒
simulated success).

### 1.6 Testnet USDC contract on Base Sepolia

Per Coinbase docs, the canonical Base Sepolia USDC is
`0x036CbD53842c5426634e7929541eC2318f3dCF7e`. Used as the default in
`x402-server.ts`; overridable via `USDC_BASE_SEPOLIA_ADDRESS` env var.
No real ERC20 transfers happen in v0.1 (simulated).

### 1.7 Existing CC e2e demo branch

`feat/e2e-demo-track-2026-04-27` (in repid-engine and trustrepid).
That branch added:
- SBT mint flow (`/api/v1/sbt/*`)
- ZKP threshold prove/verify (`/api/v1/repid/{prove,verify}-threshold`)
- Audit chain public reads (`/api/v1/audit-chain/*`)
- Demo pages: `/sbt-mint/`, `/repid-prover/`, `/audit-chain/`, `/demo-tour/`
- `sbt_mint_events` table

This sprint **does not modify** the e2e branch. Endpoints under
`/api/v1/{builder,trader,demo,tip,bet,stake}/*` are new and
disjoint from the e2e branch's surface. Demo page additions
(`/reponomics-demo/`, `/reponomics-explainer/`) are new directories.

The trustrepid `/demo-tour/` page from the e2e branch will get a 5th
tile linking to the reponomics demo — **but only when both branches
merge to main**. This sprint adds a separate `demo-tour-v2/` directory
so the tour update isn't blocked on either branch's merge order.

## 2. Tables to create vs already-existing

| Table | Status |
|---|---|
| `builders` | CREATE (does not exist) |
| `stake_deposits` | CREATE |
| `stake_authority_snapshots` | CREATE |
| `agent_wisdom_history` | CREATE |
| `agent_character_history` | CREATE |
| `linked_bets` | CREATE |
| `x402_settlements` | CREATE |
| `trading_rounds` | CREATE |
| `repid_agents` | EXISTS — adds 4 nullable columns: `character_score`, `last_active_at`, `builder_id`, `wisdom_history_count`, `character_history_count` |

`repid_agents.wisdom_score` already exists (not added by this sprint).

## 3. Plonky3 bridge interaction

- `src/zkp/plonky3-real.ts` is currently an HMAC-SHA256 stub.
- Gemini's parallel sprint
  (`hyperdag-core/feat/reponomics-circuits-2026-04-27`) ships a real
  TypeScript bridge.
- This sprint's `src/services/plonky3-bridge.ts` calls the existing
  stub interface and emits `proofBytesHex` + `isSimulated: true`. When
  Gemini's bridge merges, the body of `generateTradeAuthProof()`
  swaps; callers don't change.

## 4. What's WORKING vs SIMULATED in this sprint

| Component | Status | Switch |
|---|---|---|
| Stake vault (off-chain table) | WORKING | — |
| Authority computation (BigInt math) | WORKING | — |
| Builder registry + ghost cohort | WORKING | — |
| Wisdom score (Pythagorean Comma) | WORKING | — |
| Character score (rule-based delta) | WORKING | — |
| Linked bet placement + resolution | WORKING | — |
| Atomic settlement (PL/pgSQL function) | WORKING after migration applied | — |
| x402 challenge response (HTTP 402) | WORKING | — |
| x402 on-chain settlement verification | SIMULATED | `X402_REAL_RPC=true` + funded wallet |
| Plonky3 trade-auth proof | HMAC stub | Gemini bridge merge |
| Sports oracle outcome | SIMULATED (deterministic) | Replace `fetchOracleOutcome` |
| Two-agent trader (APM/VERITAS) | WORKING with seeded data | — |
| Demo pages | REAL (static HTML) | — |
| Tests | REAL (db mocked) | — |

Every simulated response includes an explicit `is_simulated: true`
indicator per CLAUDE-RULE-4.

## 5. Sprint scope

15 commits in repid-engine + 5 in trustrepid. Two feature branches.
No PRs. Sean reviews and merges.

Migrations not yet applied to Supabase — Sean applies when ready.
