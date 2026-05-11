# ERC-8004 Mint Test Plan — Sean Actions

**Sprint:** `feat/erc8004-minting-flow-2026-05-10`
**Target contract:** ERC-8004 `IdentityRegistry` at **`0x8004A818BFB912233c491871b3d84c89A494BD9e`** on Base Sepolia (chain 84532). Multi-chain vanity address.
**Mint function:** `register(string agentURI) returns (uint256 agentId)`. Permissionless. The signer wallet becomes the token owner.
**Signer:** Trinity Deployer wallet **`0xdf6b8215D193b11B4903d223729c3CF7A6de271d`** (per `ARCHITECTURE_LOG.md`).

## Prerequisites

1. **Branch merged to main:** `feat/erc8004-minting-flow-2026-05-10`
2. **Migration applied** via Supabase Studio → SQL Editor:
   `migrations/2026-05-10-erc8004-mint-tracking.sql`
3. **Railway env vars set on `repid-engine`** (Railway → repid-engine → Variables):
   - `TRUST_IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e`
     *(optional — defaults to this value if unset)*
   - `ERC8004_MINTER_PRIVATE_KEY=<Trinity Deployer private key, no 0x prefix or with — ethers accepts both>`
   - `BASE_SEPOLIA_RPC_URL=https://sepolia.base.org` *(optional, defaults to this)*
   - `BASE_SEPOLIA_CHAIN_ID=84532` *(optional, defaults to this)*
4. **Trinity Deployer wallet has Base Sepolia ETH for gas.**
   - Address: `0xdf6b8215D193b11B4903d223729c3CF7A6de271d`
   - Faucet: <https://portal.cdp.coinbase.com/products/faucet>
   - Need: roughly 4× a single-mint gas. A single `register(string)` call to the deployed `IdentityRegistryUpgradeable` typically costs ~120k–180k gas. Base Sepolia is currently ~0.001 gwei effective. Even at 1 gwei it's <0.001 ETH for all 4. Hold ~0.01 ETH for a wide buffer.
5. **REPID_API_KEYS env var set** on `repid-engine` Railway with at least one valid key. The POST `/mint` route requires this Bearer token.

## Step 0 — Sanity check post-deploy

```bash
curl https://repid-engine-production.up.railway.app/api/v1/agents/db5ea9f4-f1ad-445e-8c00-e13495e580f6/mint-status
```

Expected response (ATLAS, pre-mint):
```json
{
  "minted": false,
  "tokenId": null,
  "txHash": null,
  "blockNumber": null,
  "chainId": null,
  "contractAddress": null,
  "conservatorAddress": "0xdf6b8215D193b11B4903d223729c3CF7A6de271d",
  "basescanUrl": null
}
```
Note: `conservatorAddress` may already be populated from prior provisioning. That's fine — the mint will overwrite it with `signer.address` (which will be the same wallet).

## Step 1 — Dry-run gas estimate (LOCAL — no Railway needed)

```powershell
# Set env vars locally (one-shot for current shell)
$env:SUPABASE_URL='<from Railway env>'
$env:SUPABASE_SERVICE_ROLE_KEY='<from Railway env>'
$env:ERC8004_MINTER_PRIVATE_KEY='<Trinity Deployer pk>'

cd C:\Users\Cash4\repos\repid-engine
npm run backfill:erc8004:headline-4 -- --dry-run
```

Expected stdout: four `estimated_gas=...` lines plus a total. Each individual estimate should be ~100k–180k. **If any exceeds 500k or fails with revert, halt — investigate before live mint.**

## Step 2 — Single-mint via HTTP (ATLAS, lowest RepID, lowest stakes)

Dry run first:

```powershell
curl -X POST -H "Authorization: Bearer $env:REPID_API_KEY" `
  "https://repid-engine-production.up.railway.app/api/v1/agents/db5ea9f4-f1ad-445e-8c00-e13495e580f6/mint?dry_run=true"
```

Expected:
```json
{
  "dry_run": true,
  "estimated_gas": "...",
  "agent_id": "db5ea9f4-f1ad-445e-8c00-e13495e580f6",
  "signer_address": "0xdf6b8215D193b11B4903d223729c3CF7A6de271d"
}
```

Then ACTUAL mint (omit `?dry_run=true`):

```powershell
curl -X POST -H "Authorization: Bearer $env:REPID_API_KEY" `
  "https://repid-engine-production.up.railway.app/api/v1/agents/db5ea9f4-f1ad-445e-8c00-e13495e580f6/mint"
```

Expected:
```json
{
  "agentId": "db5ea9f4-f1ad-445e-8c00-e13495e580f6",
  "tokenId": "<assigned uint256 as string>",
  "txHash": "0x...",
  "blockNumber": <num>,
  "chainId": 84532,
  "contractAddress": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  "gasUsed": "<num>",
  "ownerAddress": "0xdf6b8215D193b11B4903d223729c3CF7A6de271d",
  "agentURI": "https://repid.dev/agents/db5ea9f4-.../metadata"
}
```

**Verify on Basescan:** <https://sepolia.basescan.org/tx/{txHash}>. Should show `Registered(agentId, agentURI, owner)` event and standard ERC-721 `Transfer(0x0, owner, agentId)`.

## Step 3 — Verify status reads back

```bash
curl https://repid-engine-production.up.railway.app/api/v1/agents/db5ea9f4-f1ad-445e-8c00-e13495e580f6/mint-status
```

Expected: `minted=true`, `tokenId` matches Step 2, `basescanUrl` populated.

## Step 4 — On-chain cross-verify (drift check)

```bash
curl https://repid-engine-production.up.railway.app/api/v1/agents/db5ea9f4-f1ad-445e-8c00-e13495e580f6/onchain
```

Expected:
```json
{
  "dbTokenId": "<from Step 2>",
  "onChainOwner": "0xdf6b8215D193b11B4903d223729c3CF7A6de271d",
  "dbConservator": "0xdf6b8215D193b11B4903d223729c3CF7A6de271d",
  "drift": false,
  "reason": null
}
```

`drift=true` means the DB and chain disagree — that would be a bug worth pausing on. Should not happen for a fresh mint.

## Step 5 — Backfill remaining 3 (only after Steps 2–4 pass)

```powershell
cd C:\Users\Cash4\repos\repid-engine
npm run backfill:erc8004:headline-4
```

Note: ATLAS was already minted in Step 2, so the script's `ensureNotAlreadyMinted` check will **skip ATLAS with a 409-style error and continue** to GUARDIAN, RAVEN, SOPHIA. That's expected behavior — the script processes the array sequentially and tolerates per-agent failures.

Each mint takes ~10–20 s on Base Sepolia (1 confirmation). Total wall-clock for 3 mints: ~30–60 s.

## Step 6 — Final state verification (Supabase Studio)

```sql
SELECT agent_name, erc8004_token_id, mint_tx_hash, minted_at, conservator_address
FROM repid_agents
WHERE agent_name IN ('SOPHIA','RAVEN','GUARDIAN','ATLAS')
ORDER BY agent_name;
```

Expected: 4 rows, all populated. Ready for the LinkedIn claim:

> "4 agents in production, each with an ERC-8004 token verifiable on Base Sepolia."

with 4 distinct Basescan links from `mint_tx_hash`.

## Step 7 — APM reconciliation (separate decision)

APM currently has `erc8004_token_id=1585` and `erc8004_address=0xceD17F65E03e7b3a77D5321A2d3715840317199C` — but **`0xceD17F65...` is APM's agent wallet, not the IdentityRegistry contract**. The token #1585 may or may not exist on the canonical IdentityRegistry.

Verify:
```bash
curl https://repid-engine-production.up.railway.app/api/v1/agents/065ad782-ea58-4078-9414-60a862d67ba1/onchain
```

If response is `drift=true reason=ownerOf reverted: ...`, token #1585 doesn't exist on the canonical IdentityRegistry, and APM's stored data is from a different/older system. **Decision needed:** re-mint APM with this branch's flow, or leave the legacy data and treat APM as separately provisioned.

## Rollback (if something catastrophic happens)

- **Tokens cannot be un-minted** — ERC-721 transfers are irreversible.
- **DB can be reverted** — see the `ROLLBACK` block in `migrations/2026-05-10-erc8004-mint-tracking.sql`. Drops the 4 new columns + 2 indexes.
- **Practical recovery if wrong tokens were minted:** the agent UUID ↔ tokenId mapping is database-side. Orphan the wrong tokenId (just clear `erc8004_token_id` + `mint_tx_hash` etc. in `repid_agents`), then re-mint with a corrected flow. The orphaned token sits in the deployer wallet but doesn't impact anything else.

## Time estimate for Sean

Optimistic: **15 minutes** end-to-end (Steps 1–6, assuming Railway env is ready).
Realistic: **30–45 minutes** including Railway env-var entry, faucet topup, and on-chain confirmation delays.
