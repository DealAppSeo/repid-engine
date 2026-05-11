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

---

# SECTION B — Mass Backfill (19 named agents + ATLAS)

**Prerequisite:** Section A complete (or at minimum, the dry-run gas estimates work). Trinity Deployer wallet `0xdf6b8215...` funded.

## B0 — APM reconciliation decision (BEFORE mass mint)

Mega-sprint Phase A1 ran `scripts/apm-investigation.ts` against the canonical IdentityRegistry. Findings (2026-05-10):

- APM's stored `erc8004_address` (`0xceD17F65E03e7b3a77D5321A2d3715840317199C`) is an **EOA (wallet)**, not a contract.
- Canonical `IdentityRegistry.ownerOf(1585)` returned `0xceD17F65E03e7b3a77D5321A2d3715840317199C` — i.e. **token #1585 IS real on the canonical registry, and APM's wallet IS the on-chain owner**.
- Classification: **Case Z** — APM's `erc8004_address` is being used to store the owner wallet, not the contract address. The mint history is genuine.

Apply this repair SQL in Supabase Studio (one row):

```sql
UPDATE repid_agents
   SET erc8004_address     = '0x8004A818BFB912233c491871b3d84c89A494BD9e',
       conservator_address = COALESCE(conservator_address, '0xceD17F65E03e7b3a77D5321A2d3715840317199C'),
       mint_chain_id       = 84532
 WHERE agent_name = 'APM' AND erc8004_token_id = '1585';
```

After this UPDATE, APM's row reads correctly. Token #1585 stays the same; only the field semantics are fixed. **No re-mint required.** Note: `mint_tx_hash` and `mint_block_number` will remain NULL — those would require digging the original mint transaction out of Base Sepolia history. That's a separate cleanup task; leave NULL for now.

## B1 — Mass-backfill dry run (LOCAL)

```powershell
cd C:\Users\Cash4\repos\repid-engine

# With ATLAS (if not yet minted in Section A Step 3)
npm run backfill:erc8004:mass -- --dry-run

# Without ATLAS (typical, ATLAS minted in Section A first)
npm run backfill:erc8004:mass -- --dry-run --skip-atlas
```

Expected stdout: 19 (or 20) gas estimates, each ~120k–180k gas, plus a total. Verify the wallet has enough ETH:
- ~150k gas × 19 mints × 1 gwei = 0.00285 ETH (typical Base Sepolia)
- Hold 0.01 ETH for buffer.

If any estimate fails or exceeds 500k gas, **halt and investigate before live mint.**

## B2 — Live mass backfill (CHECKPOINTED)

```powershell
npm run backfill:erc8004:mass -- --skip-atlas
```

The script processes agents in this order:

```
[ 1]  SOPHIA       (VETERAN)         ← Batch 1 (5 mints)
[ 2]  SAGE         (AUTONOMOUS)
[ 3]  SYBIL_W01    (AUTONOMOUS)
[ 4]  SYBIL_W02    (AUTONOMOUS)
[ 5]  SYBIL_W03    (AUTONOMOUS)
       ── CHECKPOINT ── verify all 5 on Basescan, press Enter
[ 6]  SYBIL_W04    (AUTONOMOUS)      ← Batch 2 (5 mints)
[ 7]  VERITAS      (AUTONOMOUS)
[ 8]  SYBIL_W05    (AUTONOMOUS)
[ 9]  MENTOR       (ESTABLISHED)
[10]  RAVEN        (ESTABLISHED)
       ── CHECKPOINT ── verify, press Enter
[11]  ORACLE       (ESTABLISHED)     ← Batch 3 (5 mints)
[12]  NEXUS        (ESTABLISHED)
[13]  SHOFET       (ESTABLISHED)
[14]  MEDIATOR     (ESTABLISHED)
[15]  CHESED       (ESTABLISHED)
       ── CHECKPOINT ── verify, press Enter
[16]  MEL          (ESTABLISHED)     ← Batch 4 (4 mints, end)
[17]  RESEARCHER   (ESTABLISHED)
[18]  TORCH        (ESTABLISHED)
[19]  GUARDIAN     (ESTABLISHED)
```

Each mint takes ~10–20 s on Base Sepolia (1 confirmation). Expected wall-clock for 19 mints: **20–40 minutes** with 3 checkpoint pauses for review.

**State persistence:** every successful mint appends one JSON line to `scripts/.erc8004-backfill-state.json`. If the script halts due to a single failure, the state file shows exactly where it stopped.

**Resume after failure:**
```powershell
# e.g. if it failed on index 13:
npm run backfill:erc8004:mass -- --skip-atlas --resume-from 13
```

**Skip the checkpoint prompts** (e.g. for unattended run from a watched terminal):
```powershell
npm run backfill:erc8004:mass -- --skip-atlas --no-checkpoint
```

## B3 — Final state verification

Supabase Studio query:

```sql
-- Headline 4 + APM + the 19 named agents
SELECT agent_name, tier, current_repid, erc8004_token_id, mint_tx_hash, minted_at, mint_chain_id
  FROM repid_agents
 WHERE agent_name IN (
   'SOPHIA','RAVEN','GUARDIAN','ATLAS','APM',
   'SAGE','SYBIL_W01','SYBIL_W02','SYBIL_W03','SYBIL_W04','SYBIL_W05','VERITAS',
   'MENTOR','ORACLE','NEXUS','SHOFET','MEDIATOR','CHESED','MEL','RESEARCHER','TORCH'
 )
 ORDER BY current_repid DESC;
```

Expected after successful run: **20 rows with non-NULL `erc8004_token_id`** (the 19 named + ATLAS), plus APM with its existing token #1585.

Aggregate query:

```sql
SELECT tier,
       COUNT(*) FILTER (WHERE erc8004_token_id IS NOT NULL) AS minted,
       COUNT(*) AS total
  FROM repid_agents
 WHERE tier IN ('VETERAN','AUTONOMOUS','ESTABLISHED','EARNING')
 GROUP BY tier
 ORDER BY tier;
```

Expected (after both Section A and B complete):
- `VETERAN`:     1 of 2 minted (SOPHIA)
- `AUTONOMOUS`:  8 of N minted (SAGE + 5× SYBIL + VERITAS + APM)
- `ESTABLISHED`: 11 of N minted
- `EARNING`:     1 of N minted (ATLAS only)

## B4 — Basescan spot-check (LinkedIn-ready)

Open 3 random tx hashes from `mint_tx_hash` on `https://sepolia.basescan.org/tx/{hash}`. Verify each shows:
- A `Transfer(0x0, 0xdf6b8215..., tokenId)` event
- A `Registered(agentId, agentURI, owner)` event  
- The agentURI resolves to `https://repid.dev/agents/{uuid}/metadata`

If `repid.dev/agents/{uuid}/metadata` returns 404, **that's a separate problem** — the mint itself is valid; the agent metadata page is what's missing. Build that page as a follow-up (sprint candidate).

## Rollback notes (mass backfill specifics)

Same as Section A's rollback: tokens cannot be un-minted; DB can be reverted via the migration's ROLLBACK block. Plus:
- `scripts/.erc8004-backfill-state.json` is local — safe to delete after Sean is satisfied (or keep as an audit log).
- If a SINGLE mint went wrong (e.g. wrong UUID typo), find the affected row, clear its `erc8004_token_id` + `mint_tx_hash` + `mint_block_number` + `minted_at` + `mint_chain_id`. The orphan token sits in the deployer wallet but doesn't affect anything else.

