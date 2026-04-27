# E2E Demo Track — Phase 1 Precheck

**Date:** 2026-04-27.
**Sprint:** `repid-engine/feat/e2e-demo-track-2026-04-27`.
**Audit posture:** read-only. No code changed in Phase 1.

This document captures what already exists in the repo against the
prerequisites of the SBT mint / ZKP threshold / audit chain demo track,
and where the gaps lie. Phases 2-7 build on top of what's documented
here, marking mocks explicitly per CLAUDE-RULE-4.

---

## 1. ERC-8004 SBT contract — read-only

- **Address:** `0x8004A818BFB912233c491871b3d84c89A494BD9e` (Base Sepolia, chainId 84532).
- **Type:** ERC-8004 IdentityRegistry (UUPS proxy). The same contract
  the fleet sprint registered all 12 agents against.
- **Mint surface:** `register(string agentURI, (string,bytes)[] metadata) returns (uint256 agentId)` —
  emits `Registered(agentId, agentURI, owner)`. There is no separate
  `mint(repIdCommitment)` function (the SBT-MINTING-FLOW.md spec is
  forward-looking; v0.1 reuses `register()`).
- **Source of truth:** `scripts/register-base-sepolia.js` (the v1 script;
  bug-fixed in `scripts/fleet-register-v2.js` on the fleet branch).
- **Constraint already documented:** `DEPLOYER_PRIVATE_KEY` in `.env`
  decodes to wallet `0xf6eE17688…3266…cb22A`. Existing fleet tokens
  are owned by `0xdf6b8215D193b11B4903d223729c3CF7A6de271d`. SBT mint
  flow inherits this constraint — minted SBTs would land on `0xf6eE…`
  unless Sean rotates the key. Default for this sprint is mock mode.
- **Inline metadata is supported:** SOPHIA's #3747 token uses
  `data:application/json;base64,…` and works fine. The mint flow uses
  the same shape.

**Decision:** SBT mint endpoint reuses `register()`. Document in the
spec doc + the response shape that v0.1 issues an "agent registry"
token; a Soulbound-only contract is v1.

## 2. Plonky3 prover wrapper

- **File:** `src/zkp/plonky3-real.ts` (20 lines).
- **Reality:** the function `generateProofReal(agentId, requesterPubkey, tier, timestamp)`
  is a deterministic HMAC-SHA256 over those four fields. Per the
  CLAUDE.md note, "Plonky3 integration is production-stub in current
  deploy; full circuit in active development (Sprint 3)."
- **Implication for this sprint:** the threshold-proof endpoints in
  Phase 3 will use the same HMAC wrapper to produce "proofs", with an
  explicit `plonky3_version: "babybear-stub-v1"` flag and a
  `mock_proof: true` indicator on every response. Verifier just
  re-hashes the inputs — same shape as the existing `/verify-proof`
  endpoint.
- **Forward path:** when Sprint 3 lands a real circuit, the wrapper's
  signature stays the same; only the body changes. Demo callers don't
  break.

## 3. `hal_audit_chain` schema and writer

- **Schema:** `supabase/migrations/20260423_add_hal_audit_chain.sql` —
  columns `id BIGSERIAL`, `source_table TEXT`, `source_id TEXT`,
  `event_payload JSONB`, `previous_entry_hash TEXT NULL`,
  `current_entry_hash TEXT NOT NULL`, `created_at TIMESTAMPTZ`.
- **Indices:** `idx_hal_audit_chain_created_at`,
  `idx_hal_audit_chain_source(source_table, source_id)`.
- **Writer:** `src/services/auditChainWriter.ts` exposes
  `appendToAuditChain(sourceTable, sourceId, eventPayload)` →
  `{id, current_entry_hash}`. Uses the `append_hal_audit_chain` RPC
  which acquires an advisory lock so concurrent appenders serialize
  correctly. **This is the function the new endpoints will call** to
  emit SBT-mint and ZKP-proof rows.
- **Verifier:** `verifyAuditChain()` walks the full chain.
- **Existing endpoint:** `GET /api/v1/audit/verify` (full chain verify).
  Does **not** support paginated reads, single-event lookup, or range
  verification. Phase 4 adds those at `/api/v1/audit-chain/*` (new path
  to avoid collision with `/api/v1/audit/`).

**Sanitization rule for new public reads:** event_payload is JSONB and
may contain holder addresses, token ids, etc. Before returning to the
public, apply a per-event-type sanitizer — see
`src/services/audit-chain-public.ts` (added in Phase 4).

## 4. Auth bypass pattern

- **File:** `src/middleware/auth.ts` (61 lines on main).
- **Existing public-read paths:** `GET /health`, `GET /healthz`, `GET /`,
  `GET /api/v1/repid/*`, `GET /api/v1/erc8004/validate/*`, plus four
  v11 external-agent paths.
- **Pattern for new bypasses:** add a single-line `if (req.method === ...
  && req.path.startsWith('/api/v1/...')) return next();` clause.

The fleet sprint added `/api/v1/fleet/*` GET to the bypass list. The
same shape works for `/api/v1/audit-chain/*` GET. The new
`/api/v1/sbt/*` POST endpoints (challenge, mint) are **NOT** behind
auth — anyone can request a challenge or submit a mint in mock mode —
so the POST-bypass path needs an explicit allowlist clause.

The new `/api/v1/repid/prove-threshold` and `/repid/verify-threshold`
endpoints — these are also intended public. The existing bypass at
line 8 already covers `GET /api/v1/repid/*`, but the new endpoints are
POST. Need explicit POST allowlist clauses for both.

## 5. `agent_kya_registry` migration status

- **Fleet sprint migration:** `supabase/migrations/20260426_fleet_registration_columns.sql`
  adds `current_token_id`, `mint_tx_hash`, `metadata_uri`,
  `metadata_inline`, `registration_status`, `superseded_by`,
  `last_chain_check`. Lives on `feat/fleet-registration-complete`,
  not yet merged to main.
- **Implication:** if the fleet branch hasn't been merged, the SBT
  mint sprint can still proceed because it touches a different table
  (`sbt_mint_events`, added in Phase 2). No dependency on the fleet
  migration.

## 6. SBT mint events — table to add

The SBT mint endpoint needs an audit row table. New migration
`20260427_add_sbt_mint_events.sql` adds:

```sql
CREATE TABLE IF NOT EXISTS sbt_mint_events (
  id              BIGSERIAL PRIMARY KEY,
  holder_address  TEXT NOT NULL,
  token_id        TEXT,
  tx_hash         TEXT,
  ipfs_uri        TEXT,
  metadata_inline BOOLEAN NOT NULL DEFAULT TRUE,
  rep_id_commitment TEXT,
  status          TEXT NOT NULL,           -- pending | minted | failed | mock
  is_mock         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  audit_chain_id  BIGINT
);
```

Plus an index on `holder_address` for the demo page's holder lookup.

## 7. Pinata pinning — optional, fallback to inline

- **No PINATA_JWT in `.env`** as of this sprint.
- **Fallback chosen:** inline `data:application/json;base64,…` URI in
  `tokenURI`. Same shape as SOPHIA #3747's working metadata. No new
  external dependency required.
- When Sean adds PINATA_JWT to `.env`, the SBT mint service will
  detect it and pin to IPFS instead — code path is in place for that
  swap; Phase 2 builds it conditionally.

## 8. New external dependencies — tally

This sprint introduces **zero** new npm packages. Everything uses what
already exists: `ethers`, `@supabase/supabase-js`, `crypto`, `express`,
the existing audit chain writer.

## 9. Wallet identity blocker — inherited

Same blocker the fleet sprint surfaced. Phases 2-3 default to
**mock mode** (`SBT_MINT_MOCK=1`, `THRESHOLD_PROOF_MOCK=1`). Mock
returns deterministic data with explicit `is_mock: true` indicators
on every response. When Sean rotates `DEPLOYER_PRIVATE_KEY` to the
correct wallet (`0xdf6b…271d`), removing the env flag enables real
mints.

This is **not** a build blocker — the API surface, the demo pages,
the audit chain integration, and the tests all ship regardless. Only
the "actually push a transaction" step waits on the same wallet
question that fleet is waiting on.

## Summary — what's real vs mock

| Component | Real | Mock |
|---|---|---|
| SBT mint endpoint shape | yes | — |
| SBT mint actual on-chain tx | — | `SBT_MINT_MOCK=1` default; gated by wallet rotation |
| Plonky3 threshold proof | — | HMAC-SHA256 stub (Sprint 3 = real circuit) |
| Plonky3 threshold verify | — | re-hashes inputs against same HMAC |
| Audit chain writer | yes | — |
| Audit chain public reads | yes | — |
| Demo pages | yes (static HTML) | — |
| Integration tests | yes | use mocks for external (RPC, prover) |

CLAUDE-RULE-4 compliance: every mock response carries an explicit
`is_mock: true` or `mock_proof: true` field, plus a `notes` string
explaining what would change in production.
