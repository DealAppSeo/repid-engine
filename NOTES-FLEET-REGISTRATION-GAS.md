# Fleet registration — pre-flight notes (BLOCKED)

**Date:** 2026-04-26.
**Sprint:** `feat/fleet-registration-complete`.
**Status:** Phase 5 (real mints) is **NOT executed** in this sprint. Phases 1-4 and 6-10 are complete (see commit ladder).

---

## Hard blocker: wallet identity mismatch

The spec names **Trinity Deployer = `0xdf6b8215D193b11B4903d223729c3CF7A6de271d`** as the wallet that owns the existing fleet tokens. Verified on-chain:

| Token | Owner |
|---|---|
| #1583, #1612, #1632, #1644 (NEXUS dups) | `0xdf6b…271d` |
| #1848 (VERITAS) | `0xdf6b…271d` |
| #1849 (TORCH) | `0xdf6b…271d` |
| #1850 (HDM) | `0xdf6b…271d` |
| #1851 (MEL) | `0xdf6b…271d` |
| #3747 (SOPHIA) | `0xdf6b…271d` |

But the **`DEPLOYER_PRIVATE_KEY`** in `.env` corresponds to **`0xf6eE1768868c3266868edcA78bC41C50309cb22A`** (current balance: 0.0041 ETH).

Implications:

1. **`setAgentURI()` is not callable** for the orphan tokens — only the token owner can call it, and `0xf6eE…` is not the owner. So we cannot fix the orphans in-place.
2. **`register()` mints are still callable** from `0xf6eE…`, but the new tokens would be owned by `0xf6eE…` rather than `0xdf6b…271d`. That puts the new fleet tokens on a different owner than the existing fleet (SOPHIA #3747 in particular). Marco / Vitto / Leonard reading the chain would see two owners across the fleet, which is confusing.
3. **The fleet status endpoint can still report ground truth** for the current state regardless of whether new mints happen — this is why Phases 7-9 are unblocked.

## Two ways to unblock (Sean's call)

**Option A (recommended).** Put the `0xdf6b…271d` wallet's private key into `DEPLOYER_PRIVATE_KEY` (overwrite the current `0xf6eE…` value). Then run:

```
cd /c/Users/Cash4/repos/repid-engine
node scripts/fleet-register-v2.js                # dry-run, prints actions
node scripts/fleet-register-v2.js --execute      # real mints, 5s cooldown between
```

This produces a clean fleet on the same owner as SOPHIA #3747, and the new tokens come straight from the wallet that already controls the existing ones. (Sub-option: also call `setAgentURI(orphanId, dataURI)` on each orphan to fix in-place — saves having multiple working tokens per agent.)

**Option B.** Accept the new mints landing on `0xf6eE…`. Document the two-owner reality explicitly. The fleet status endpoint will surface this and the demo page will show owners alongside token IDs. Less clean but unblocks immediately.

## Gas budget — sufficient on either wallet

Estimated gas per `register()` call: ~150-300k. Base Sepolia gas at the time of writing is sub-gwei. 11 mints + occasional slack: well under 0.001 ETH total. Both candidate wallets have enough.

## What the dry-run shows

Status-only run on 2026-04-26 (read-only, no transactions):

```
SOPHIA   action: SKIP    (already inline-perfect)              data URI 1433 bytes
NEXUS    action: REMINT  (4 orphans #1583/1612/1632/1644)     data URI 1381 bytes
VERITAS  action: REMINT  (1 orphan #1848)                     data URI 1381 bytes
APM      action: MINT    (not yet registered)                  data URI 1465 bytes
TORCH    action: REMINT  (1 orphan #1849)                     data URI 1353 bytes
HDM      action: REMINT  (1 orphan #1850)                     data URI 1321 bytes
MEL      action: REMINT  (1 orphan #1851)                     data URI 1381 bytes
GCM      action: MINT    (not yet registered)                  data URI 1349 bytes
CHESED   action: MINT    (not yet registered)                  data URI 1481 bytes
ORCH     action: MINT    (not yet registered)                  data URI 1377 bytes
W3C      action: MINT    (not yet registered)                  data URI 1373 bytes
SHOFET   action: MINT    (not yet registered)                  data URI 1557 bytes
```

11 transactions total: 5 REMINT (existing orphans) + 6 MINT (new agents). All metadata payloads under 1.6 KB; well below the ~32 KB contract limit.

## Why I did not execute mints from `0xf6eE…`

Per the sprint rules:
- "CLAUDE-RULE-2: dry run before real transactions; surface gas issues to Sean before topping up."
- "DO NOT autonomously top up wallet from faucets (Sean does that)."

Wallet identity mismatch is the same class of hard blocker as gas insufficiency — Sean owns the keys; I should not assume the .env mismatch was intentional. Decision deferred to Sean.

## What is committed by this sprint regardless

- 12 metadata JSON files at `scripts/fleet-metadata/` (Phase 2).
- `scripts/fleet-register-v2.js` with dry-run + `--execute` + `--only` + `--status-only` modes (Phase 3).
- Migration at `supabase/migrations/20260426_fleet_registration_columns.sql` adding `current_token_id`, `mint_tx_hash`, `metadata_uri`, `metadata_inline`, `registration_status`, `superseded_by`, `last_chain_check`.
- Public endpoints `GET /api/v1/fleet/status` and `GET /api/v1/fleet/agent/:name` (Phase 7).
- Static demo page at `trustrepid/public/fleet-status/index.html` (Phase 9).
- Documentation at `docs/FLEET-REGISTRATION.md` (Phase 10).

When Sean unblocks the wallet question, running `node scripts/fleet-register-v2.js --execute` finishes the sprint. No further code changes required.
