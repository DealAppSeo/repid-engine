# ERC-8004 ReputationRegistry Test Plan — Sean Actions

**Sprint:** `feat/erc8004-spec-compliance-2026-05-10`
**Target contract:** `ReputationRegistry` at **`0x8004B663056A597Dffe9eCcC1965A193B7388713`** on Base Sepolia (chain 84532). Multi-chain vanity. `getVersion()` returned `"2.0.0"` 2026-05-10.
**Probe verified live:** `getIdentityRegistry()` returned `0x8004A818BFB912233c491871b3d84c89A494BD9e` — matches canonical IdentityRegistry. `getClients(1585)` returned `[]` — APM has ZERO on-chain feedback signals; HyperDAG will be the first reviewer.

## Pre-requisites

1. **Branch merged to main:** `feat/erc8004-spec-compliance-2026-05-10` (DEFERRED — Sean merges all together later)
2. **Migrations applied** in this order:
   - `migrations/2026-05-10-graph-rag-foundation.sql` (from Sprint 4)
   - `migrations/2026-05-10-erc8004-mint-tracking.sql` (from Sprint 6)
   - `migrations/2026-05-10-erc8004-reputation-tracking.sql` (this sprint)
3. **APM Case Z repair** (one-line UPDATE from megasprint test plan §B0)
4. **Spokespersons minted** — run Sprint 6 mass mint script first:
   ```powershell
   npm run backfill:erc8004:mass -- --skip-atlas
   ```
   The 4 spokespersons are at indices 1 (SOPHIA), 7 (VERITAS), 13 (SHOFET — wait, sprint header says CHESED. Let me re-verify).
5. **Railway env vars** on `repid-engine`:
   - `ERC8004_REPUTATION_CONTRACT=0x8004B663056A597Dffe9eCcC1965A193B7388713` *(optional — defaults to this)*
   - `ERC8004_REPUTATION_WRITER_KEY=<Trinity Deployer pk>` *(or reuse `ERC8004_MINTER_PRIVATE_KEY`)*
   - `BASE_SEPOLIA_RPC_URL=https://sepolia.base.org` *(optional)*
   - `ERC8004_REPUTATION_CHAIN_ID=84532` *(optional)*
   - `PUBLIC_ENGINE_BASE_URL=https://repid-engine-production.up.railway.app` *(optional, used in feedbackURI)*
6. **Wallet `0xdf6b8215...` has Base Sepolia ETH.** Each `giveFeedback` call is ~200k–300k gas; 4 writes ≈ <0.001 ETH total. Hold 0.005 ETH buffer.

## Squad spokespersons (Path A — worker-backed only)

| Squad | Spokesperson | Tier | Current RepID | Railway worker |
|---|---|---|---|---|
| Wisdom | SOPHIA | VETERAN | 9961 | trinity-sophia |
| Truth | VERITAS | AUTONOMOUS | 5500 | trinity-veritas |
| Compassion | CHESED | ESTABLISHED | 1915 | trinity-chesed |
| Justice | SHOFET | ESTABLISHED | 2510 | trinity-shofet |

Defined in `src/config/squad-architecture.ts`. RepID values as of 2026-05-10 evening — backfill writes the live value at the moment of the call.

## Step 1 — Probe sanity check (LOCAL, read-only)

```powershell
cd C:\Users\Cash4\repos\repid-engine
npm run probe:reputation
```

Expected stdout (matches verified 2026-05-10):
```
Step 1: provider.getCode(0x8004B663...)
  → contract present
Step 2: reputation.getVersion()
  → "2.0.0"
Step 3: reputation.getIdentityRegistry()
  → 0x8004A818BFB912233c491871b3d84c89A494BD9e ✅
Step 4: reputation.getSummary(1585, [0x0], "", "")
  count=0 summaryValue=0 valueDecimals=0
Step 5: reputation.getClients(1585) → []
```

Any deviation = halt and investigate before continuing.

## Step 2 — Health-check registration file (after redeploy)

```bash
SOPHIA=f3ef0bf8-5cdc-4fad-bce8-5144f01dc271
curl https://repid-engine-production.up.railway.app/api/v1/agents/$SOPHIA/registration.json
```

Expected (after SOPHIA is minted): spec-compliant JSON with `type:"erc8004-registration-v1"`, 5 services entries (http, http-verify, http-recall, http-card, http-feedback), `registrations:[{agentRegistry:"eip155:84532:0x8004A818...", agentId:"<token>"}]`, `supportedTrust:["reputation"]`, and HyperDAG extension block.

Before SOPHIA is minted: `404 {error: "agent_not_found_or_not_minted"}`.

## Step 3 — Dry-run all 4 spokespersons

```powershell
npm run reputation:backfill:spokespersons -- --dry-run
```

Expected: 4 gas estimates, each ~200k–300k. Total ~1M gas. **If any spokesperson is UNMINTED**, the script halts with a clear "Run Sprint 6 mass-mint backfill first" message — go back and mint them.

## Step 4 — Live write for SOPHIA only (smallest-risk first probe)

```powershell
$SOPHIA = "f3ef0bf8-5cdc-4fad-bce8-5144f01dc271"
curl.exe -X POST -H "Authorization: Bearer $env:REPID_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{"dry_run":true}' `
  "https://repid-engine-production.up.railway.app/api/v1/agents/$SOPHIA/reputation/write"
```

Expect a `dry_run:true` JSON with `gas_estimate`, `gas_price_gwei`, and the operator wallet address.

Then live (no body):

```powershell
curl.exe -X POST -H "Authorization: Bearer $env:REPID_API_KEY" `
  "https://repid-engine-production.up.railway.app/api/v1/agents/$SOPHIA/reputation/write"
```

Expected: `success:true, tx_hash:"0x...", block_number:..., basescan_url:"https://sepolia.basescan.org/tx/0x..."`.

Verify on Basescan — the tx should show a `Feedback` event (the exact event name lives in the ABI; expect something like `FeedbackGiven`) emitted from `0x8004B663...` with the SOPHIA tokenId, value 9961 (or current), tag1=`"hyperdag_repid"`, tag2=`"tier:VETERAN"`.

## Step 5 — Cross-verify on-chain

```bash
curl https://repid-engine-production.up.railway.app/api/v1/agents/$SOPHIA/reputation/onchain
```

Expected:
```json
{
  "feedback_count": 1,
  "latest_value": "9961",
  "value_decimals": 0,
  "operator_address": "0xdf6b8215..."
}
```

`feedback_count=1` confirms HyperDAG's protocol wallet is now a recognized feedback provider for SOPHIA.

## Step 6 — Live backfill remaining 3 spokespersons

```powershell
npm run reputation:backfill:spokespersons -- --resume-from 1
```

(Index 0 is SOPHIA which was already written in Step 4 — `--resume-from 1` skips it.) With 3 writes and checkpoint-every-2, expect 1 checkpoint pause to verify after VERITAS + CHESED, then SHOFET solo.

## Step 7 — Final state verification

Supabase Studio:

```sql
-- Per-agent reputation tracking
SELECT agent_name, current_repid, tier, last_reputation_repid,
       last_reputation_tx_hash, last_reputation_written_at,
       reputation_write_count
  FROM repid_agents
 WHERE agent_name IN ('SOPHIA','VERITAS','CHESED','SHOFET')
 ORDER BY agent_name;

-- Append-only audit log
SELECT agent_id, repid_value, tier, tx_hash, block_number, chain_id,
       contract_address, created_at
  FROM erc8004_reputation_writes
 ORDER BY created_at DESC;
```

Expected: 4 agent rows with non-NULL `last_reputation_*`. 4 audit rows in `erc8004_reputation_writes`.

## Step 8 — Spec-compliant public surface

After all 4 spokespersons have feedback written, hit the public endpoints from a CORS-allowed origin (or curl) for at least one agent:

```bash
# Registration file (this is what ERC-8004 indexers fetch via tokenURI)
curl https://repid-engine-production.up.railway.app/api/v1/agents/$SOPHIA/registration.json

# Feedback payload (this is what was referenced in giveFeedback's feedbackURI param)
curl https://repid-engine-production.up.railway.app/api/v1/agents/$SOPHIA/reputation/payload.json

# Live on-chain summary
curl https://repid-engine-production.up.railway.app/api/v1/agents/$SOPHIA/reputation/onchain
```

All three should return 200 with valid JSON. Cache-Control headers should be present on the JSON-file endpoints.

## Rollback

- **Cannot un-write feedback** — ERC-8004 `giveFeedback` events are immutable. If a wrong value was written, use `revokeFeedback(agentId, feedbackIndex)` to mark it revoked on-chain (separate function, not yet wrapped in the service — follow-up sprint).
- **DB can be reverted** via the migration's ROLLBACK block.
- **Practical recovery** if a wrong write went through: leave it on-chain, write a corrected feedback in the next call. The `getSummary` view aggregates HyperDAG-owned feedback by clientAddress, so the latest correct write becomes the operative summary.

## Time estimate for Sean

- Optimistic: **20 minutes** if Railway env vars are already set + spokespersons minted.
- Realistic: **45–60 minutes** including Sprint 6 mass-mint prerequisite (~20–40 min) + env setup + Basescan verification.
