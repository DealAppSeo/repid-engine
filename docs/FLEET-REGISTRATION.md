# Fleet registration — workflow and current status

**Sprint:** `feat/fleet-registration-complete`, 2026-04-26.
**Status:** scaffolding complete; Phase 5 mints **deferred** pending wallet
identity reconciliation (see `NOTES-FLEET-REGISTRATION-GAS.md`).

This doc explains how the 12-agent fleet is registered to the ERC-8004
Identity Registry on Base Sepolia, why the previous registration script
left orphans, and how to verify the current state without trusting any
local cache.

---

## 1. The 12 fleet agents

Canonical list (matches `agent_kya_registry`):

| Class | Agents |
|---|---|
| Sensory | NEXUS, TORCH, GCM |
| Interneuron | APM, VERITAS, MEL |
| Motor | SOPHIA, HDM, W3C |
| Orchestrator | ORCH, SHOFET, CHESED |

Per-agent metadata lives at `scripts/fleet-metadata/<NAME>.json`. Each
file is a complete ERC-8004 v1 metadata payload with constitutional DNA,
capability list, and a tier pointer.

## 2. The bug-fixed registration script

`scripts/fleet-register-v2.js` replaces `scripts/register-base-sepolia.js`.
The old script is intentionally not deleted (per sprint rules) so the
diff is reviewable.

Bugs fixed:

| Old script | v2 script |
|---|---|
| Hardcoded 4-agent list | Reads 12 agent names from the canonical list |
| Wrote `tx.hash` to `repid_agents.erc8004_address` | Parses `agentId` from `Registered` event, writes to `agent_kya_registry.agent_id_onchain` and `current_token_id` |
| Off-chain HTTPS URI scheme | Inline `data:application/json;base64,...` URI |
| No status state machine | `registration_status`: `verified` / `pending` / `failed` / `orphaned` / `deprecated_duplicate` |
| No dedupe handling | Logs each old NEXUS duplicate to `trinity_agent_logs` with `superseded_by=<new>` |
| No dry-run | Default mode is dry-run; `--execute` is required to send transactions |

### Modes

```
node scripts/fleet-register-v2.js                # dry-run (default)
node scripts/fleet-register-v2.js --execute      # real mints, 5s cooldown
node scripts/fleet-register-v2.js --status-only  # read-only chain query
node scripts/fleet-register-v2.js --only=NEXUS   # one agent at a time
```

Dry-run prints the exact `register()` call shape, the data URI byte size
(must be < 32 KB), the gas estimate, and the per-agent action decision
(SKIP / REMINT / MINT / ERROR). Nothing is sent.

`--status-only` queries the chain for the orphan token IDs documented in
the spec (1583/1612/1632/1644 NEXUS, 1848 VERITAS, 1849 TORCH, 1850 HDM,
1851 MEL, 3747 SOPHIA) and reports each one's owner + URI without
modifying state.

## 3. Schema additions

Migration `supabase/migrations/20260426_fleet_registration_columns.sql`
adds:

- `current_token_id TEXT` — the canonical token id we want consumers to
  look at, even when `agent_id_onchain` is stale.
- `mint_tx_hash TEXT` — the tx that minted the canonical token.
- `metadata_uri TEXT` — the inline data URI we submitted (or the
  off-chain URL, if legacy).
- `metadata_inline BOOLEAN DEFAULT FALSE` — quick discriminator.
- `registration_status TEXT` — state machine value.
- `superseded_by TEXT` — for `deprecated_duplicate` rows, points to the
  canonical replacement.
- `last_chain_check TIMESTAMPTZ` — when the row was last reconciled
  against on-chain state.

All additive; no destructive change.

## 4. Public verification endpoints

Two unauthenticated GET endpoints, both running a live RPC query against
the ERC-8004 contract (no DB-cache trust):

```
GET /api/v1/fleet/status
GET /api/v1/fleet/agent/:name
```

`/fleet/status` returns:

```jsonc
{
  "fleet_size": 12,
  "fully_discoverable": <count>,
  "issues": <count>,
  "contract_address": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  "chain": "base-sepolia",
  "verification_method": "live_rpc_query",
  "agents": [
    {
      "name": "SOPHIA",
      "agent_class": null,
      "fleet_role": "wisdom_output",
      "on_chain": true,
      "token_id": "3747",
      "owner": "0xdf6b...271d",
      "metadata_uri": "data:application/json;base64,...",
      "metadata_inline": true,
      "metadata_reachable": true,
      "metadata_summary": { "name": "SOPHIA", "tier": "AUTONOMOUS" },
      "explorer_url": "https://sepolia.basescan.org/token/0x...?a=3747",
      "rep_id_tier": "AUTONOMOUS",
      "registration_status": "verified",
      "last_verified": "..."
    },
    ...
  ]
}
```

`/fleet/agent/:name` returns a single agent's full record (case-insensitive).

Auth bypass added in `src/middleware/auth.ts` — anyone can hit these
without an API key.

## 5. Demo page

Static HTML at `trustrepid/public/fleet-status/index.html`. Calls the
public endpoint above and renders one card per agent with: name, role,
on-chain status, token id (linked to BaseScan), owner, metadata
inline/reachable flags, RepID tier, and a collapsible "raw json" detail
view. The endpoint URL is editable in the UI so reviewers can test
against staging or local deployments.

To deploy: drop the directory at `trustrepid.dev/fleet-status/` (or any
static host). It calls a configurable endpoint at runtime — no rebuild
needed if the API URL changes.

## 6. Current state (read with `--status-only`, 2026-04-26)

| Agent | Action | Token | Owner | Notes |
|-------|--------|------:|---|---|
| SOPHIA | SKIP | #3747 | 0xdf6b…271d | Already inline-perfect — gold standard. |
| NEXUS  | REMINT | (none) | — | 4 orphans (1583, 1612, 1632, 1644) on 0xdf6b…271d. |
| VERITAS | REMINT | (none) | — | Orphan #1848 on 0xdf6b…271d. |
| APM    | MINT | (none) | — | Not yet registered. |
| TORCH  | REMINT | (none) | — | Orphan #1849 on 0xdf6b…271d. |
| HDM    | REMINT | (none) | — | Orphan #1850 on 0xdf6b…271d. |
| MEL    | REMINT | (none) | — | Orphan #1851 on 0xdf6b…271d. |
| GCM    | MINT | (none) | — | Not yet registered. |
| CHESED | MINT | (none) | — | Not yet registered. |
| ORCH   | MINT | (none) | — | Not yet registered. |
| W3C    | MINT | (none) | — | Not yet registered. |
| SHOFET | MINT | (none) | — | Not yet registered. |

Total work to complete the fleet: **11 transactions** (5 REMINT + 6 MINT).

## 7. Why Phase 5 is deferred

Hard blocker: `DEPLOYER_PRIVATE_KEY` in `.env` corresponds to wallet
`0xf6eE…3266…cb22A`, but every existing fleet token is owned by
`0xdf6b…271d` (the spec's canonical Trinity Deployer wallet). Mints from
the wrong wallet would put the new fleet on a different owner;
`setAgentURI()` cannot be called against the orphans because the caller
is not the owner.

Resolution requires Sean to either:

1. Replace `DEPLOYER_PRIVATE_KEY` with the `0xdf6b…271d` private key, or
2. Accept the new mints landing on `0xf6eE…` (two-owner reality).

Detailed analysis: `repid-engine/NOTES-FLEET-REGISTRATION-GAS.md`.

When unblocked: `node scripts/fleet-register-v2.js --execute`. The
script handles everything — no further code changes required.

## 8. How to verify yourself

```bash
# 1. From any browser:
open https://repid-engine-production.up.railway.app/api/v1/fleet/status

# 2. From the demo page:
open https://trustrepid.dev/fleet-status/
# (or wherever Sean deploys it)

# 3. From a terminal — check a single agent:
curl https://repid-engine-production.up.railway.app/api/v1/fleet/agent/SOPHIA

# 4. Direct from chain (bypass our service):
cast call 0x8004A818BFB912233c491871b3d84c89A494BD9e \
  "tokenURI(uint256)" 3747 \
  --rpc-url https://sepolia.base.org
```

The fourth check is what Marco / Vitto would run if they wanted to
verify our service is reporting truthfully. The endpoint returns the
exact same data the chain holds.
