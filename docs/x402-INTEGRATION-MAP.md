# x402 — Integration Map (forward-looking)

**Date:** 2026-04-24
**Companion to:** `docs/x402-CURRENT-STATE.md`
**Status:** Design only. Nothing in this map is implemented yet. Sections marked
*PROJECTED* describe products whose code I have not located in the audit.

---

## Architecture in one paragraph

`/x402-gate` is the **policy oracle**: "given this agent's RepID, can it authorize $X?"
It returns a decision over local DB state and never touches money. A protocol-level
**paywall middleware** is what we will add: it speaks Coinbase's x402 wire
(`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`), verifies and settles
via a facilitator, and **calls the gate as a pre-flight authorization check** when the
caller is a known agent. The gate doesn't change. The paywall composes the gate with
real settlement. Both surfaces are useful on their own; together they're the full
RepID-aware payment flow.

```
                       ┌─────────────────────────────┐
   client request ───▶ │  paywall middleware         │ ──▶ Coinbase facilitator
                       │  (protocol: PAYMENT-*)      │     /verify  /settle
                       └──────────┬──────────────────┘
                                  │
                                  │ pre-flight policy
                                  ▼
                       ┌─────────────────────────────┐
                       │  /agents/:id/x402-gate      │
                       │  (oracle: RepID + EAS stub) │
                       └─────────────────────────────┘
```

---

## A) repid-engine endpoints

### A.1 Endpoints to make payable

Listed in priority order.

| Endpoint | Why | Per-call base | Free quota / day |
|---|---|---|---|
| `POST /api/v1/hal/signals` | The actual valuable signal; trustshell + trustchat consume it. | $0.001 USDC | 100 / RepID |
| `POST /api/v1/prove-repid` | Real CPU work (ZKP gen). | $0.005 USDC | 50 / RepID |
| `POST /api/v1/batch/prove` | Same as above, batched. Charge per-item. | $0.004 USDC × items | 50 items / day |
| `POST /mcp-call` | Each tool call is a discrete unit of value. | $0.002 USDC | 200 / RepID |
| `POST /score-event` | Only if 3rd parties ever submit scores. Internal today, so defer. | n/a | n/a |

`POST /agents/:id/x402-gate` itself stays free — it's a pre-flight oracle and
charging for it would create a chicken-and-egg problem with the paywall.

### A.2 Pricing tiers (RepID-as-discount)

Two dimensions vary by RepID tier: **per-call price** and **daily free quota**.

```
discount(repId) = clamp(0, 0.5, 0.5 × (repId - 1000) / 9000)
price(endpoint, repId) = base(endpoint) × (1 - discount(repId))
free_quota(endpoint, tier) = lookup(endpoint, tier)
```

| Tier | Discount | Free quota multiplier |
|---|---|---|
| `CUSTODIED_DBT` (10–999) | 0% | 1× |
| `EARNING_AUTONOMY` (1000–4999) | up to 22% | 10× |
| `AUTONOMOUS` (5000–10000) | up to 50% | 100× |

Concrete: HAL signals base $0.001 → AUTONOMOUS agent at RepID 8000 pays $0.000611
per call **and** gets 10,000 free calls/day.

**Where free-quota state lives:** Redis (`ioredis` already in `package.json`). Key
`x402:quota:<endpoint>:<repid_or_ip>:<yyyymmdd>`, TTL 24h+1h. Falls open if Redis is
unavailable, matching the existing `rateLimitMiddleware` posture.

### A.3 402 response format (canonical)

The middleware emits the spec shape. From Coinbase's `coinbase/x402` README:

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64(PaymentRequired)>
Content-Type: application/json

{
  "x402Version": 1,
  "accepts": [
    {
      "scheme": "exact",
      "network": "base-sepolia",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",   // USDC on Base Sepolia
      "maxAmountRequired": "1000",                              // 0.001 USDC, 6 decimals
      "resource": "https://repid-engine.../api/v1/hal/signals",
      "description": "HAL signal extraction",
      "mimeType": "application/json",
      "payTo": "<engine receiving address>",
      "maxTimeoutSeconds": 60,
      "extra": {
        "repId": <agent rep>,
        "tier": "<tier>",
        "freeQuotaRemaining": 0,
        "discountApplied": <0..0.5>
      }
    }
  ],
  "error": "Free quota exhausted"
}
```

**Token amounts:** USDC has 6 decimals; `$0.001 = "1000"` in `maxAmountRequired`. Every
amount the spec carries is the raw integer string in token-base units.

### A.4 Verification flow

```
1. Paywall reads PAYMENT-SIGNATURE; if missing → 402 with PAYMENT-REQUIRED.
2. Decode PaymentPayload (base64 JSON).
3. Call gate (in-process, not HTTP) for the agent if x-api-key resolves to one:
     allowed = await x402Gate({ agentId, amount, currency: 'USDC' })
   If !allowed → 402 with reason from gate (overrides quota path).
4. POST PaymentPayload + PaymentRequirements to facilitator /verify.
   On invalid → 402 with facilitator error.
5. Process the request normally.
6. POST settlement to facilitator /settle.
7. Set PAYMENT-RESPONSE header with base64(SettlementResponse).
8. Insert one row into repid_score_events with x402Context populated, reusing the
   existing JSONB metadata field. Log economic_impact_usdc as the settled amount.
```

Replay protection comes from the facilitator (each PaymentPayload is one-shot at the
verify endpoint — facilitator rejects re-submission of the same signed payload).
Engine-side belt-and-braces: cache `payload.signature` in Redis with TTL =
`maxTimeoutSeconds × 2` and 409 on collision.

---

## B) trustshell npm package

**Today:** `@hyperdag/trustshell@0.1.0` exports `class TrustShell` with
`evaluate / report / getRepID / getLLMTrustScore`. No 402 handling. No wallet.
(`packages/trustshell` v0.2.0 is unpublished and has different shape — see
ecosystem audit.)

**Target shape:**

```ts
const shell = new TrustShell({
  agentId, apiKey,
  llmProvider: 'anthropic',
  profile: 'balanced',
  // NEW:
  wallet: {
    network: 'base-sepolia',
    payer: walletClient,            // viem walletClient OR private key, dev only
    maxAutoPayUSDC: 0.10,           // hard ceiling per call
    dailyAutoPayCapUSDC: 5.00,      // hard ceiling per UTC day
  }
});

// evaluate() auto-pays 402s up to the configured ceilings.
// On 402: shell decodes PAYMENT-REQUIRED, signs PaymentPayload, retries with
//   PAYMENT-SIGNATURE header, then surfaces PAYMENT-RESPONSE as result.txReceipt.
const r = await shell.evaluate(text, certainty);
// r.payment?: { txHash, settledUSDC, facilitator }
```

**Auto-pay default: OFF.** Opt-in. Otherwise an upgrade silently starts spending the
agent's wallet — bad surprise. When OFF, `evaluate()` returns the raw 402 in
`result.paymentRequired` and the caller decides what to do.

**Wallet bootstrap:** see Section C below — TrustShell never holds keys.

---

## C) Agent wallets (cross-cutting)

**Current state:** the engine assigns `erc8004_address: wallet_address ||
'external:<uuid>'` at registration (`src/routes/agents-external.ts:88`). Most agents
have a stub `external:` address. There is no wallet management here.

**Target model: non-custodial, deterministic-derived from the user's master key.**

```
agent_signing_key = HKDF-SHA256(
  user_master_key,
  salt = "hyperdag/agent/v1/" + agent_id,
  info = "x402-payments"
)
```

Why:
- We never hold the key. Custodial = regulated money transmitter, do not want.
- Per-agent isolation: compromising one agent's key doesn't compromise others.
- Reproducible: user can recreate the agent's signing key from their master key + agent_id.
- Recoverable: if the user has their master key, they have all their agents' wallets.

**The user's master key** is *not* in scope for this map — that's a TrustRepID account
question. The deterministic derivation just needs the master key as input; how the
user holds it (Privy, browser-side WebAuthn, hardware wallet, MPC, etc.) is settled
elsewhere.

**For the Phase 3 reference impl:** since trustshell v0.1.0 doesn't have wallet UX yet,
the reference implementation must be testable by a hand-crafted client that injects a
dev private key. Wallet derivation is a follow-up sprint.

---

## D) RepID gating mechanics — formal restatement

The existing oracle (`/x402-gate`) returns a binary allowed/denied based on tier vs
amount. The paywall extends the oracle's model in three dimensions:

1. **Per-call price discount** (`A.2`): linear in RepID above 1000, capped at 50%.
2. **Free-quota multiplier** (`A.2`): 1× / 10× / 100× by tier.
3. **Daily x402 spend cap** (NEW): the paywall tracks per-agent spend in Redis.
   - `CUSTODIED_DBT`: $0 cap (must use free quota only)
   - `EARNING_AUTONOMY`: $10/day
   - `AUTONOMOUS`: $1,000/day
   These are spend ceilings the paywall enforces *in addition to* whatever the
   trustshell client enforces locally. Defense in depth.

The gate handler stays unchanged — it's still the per-payment authorization oracle.
Ceilings/discounts live in the paywall middleware as configuration, so they can be
tuned without touching the gate.

---

## E) PROJECTED — TrustMarket.dev (agent skill marketplace)

**Audit status:** I did not locate a `trustmarket` repo in `C:/Users/Cash4/repos/`
or `OneDrive/Desktop/`. Treating as greenfield design.

**Integration shape:**

```
buyer agent ──▶ skill listing URL ──▶ marketplace gateway
                                            │
                                            ├── 402 PAYMENT-REQUIRED with split:
                                            │     90% → seller agent address
                                            │     5%  → marketplace operator
                                            │     5%  → insurance pool (see G)
                                            │
                                            ├── x402 verify+settle (single facilitator
                                            │   call with multi-pay-out splits if the
                                            │   facilitator supports them; otherwise
                                            │   gateway settles to itself, then fans
                                            │   out off-protocol)
                                            │
                                            └── after settlement, gateway calls into
                                                seller's actual skill endpoint and
                                                relays the response.
```

**Seller's reputation gating:** before a skill is even *listed*, the marketplace queries
`/api/v1/repid/<seller_id>` and refuses listings below CUSTODIED_DBT exit (RepID 1000).
After every transaction, marketplace POSTs to `/score` with
`eventType: 'PREDICTION_RESOLVE'` (or a new event type) to update seller reputation
based on buyer's rating.

**Buyer's gating:** marketplace calls `/x402-gate` with the listing price before
accepting the buyer's payment. AUTONOMOUS-only listings can require
`requiredTier='AUTONOMOUS'` upfront.

---

## F) PROJECTED — TrustEscrow

**Audit status:** no `trustescrow` repo located. Greenfield design.

**Use case:** payment held against ABT (`agent-bonded token`?) collateral, released on
condition. Maps cleanly onto x402 *delayed settlement*:

1. Buyer creates 402 with `extra.escrowConditions = { releaseOn, timeout, arbiter }`.
2. Facilitator (or our wrapper) verifies but does not settle — funds locked.
3. Trigger fires → settle. Failure / timeout → refund.

**Where this lives:** as a `trustescrow-engine` service that wraps the facilitator's
`/verify` (locking) and only later calls `/settle` (release) or `/refund`. Out of
scope for repid-engine code; in scope for the integration map.

**Connection to RepID:** the arbiter's RepID determines arbitration weight. Multiple
arbiters → BFT vote weighted by RepID (mirrors trinity-ecosystem's `BFTEngine`).

---

## G) PROJECTED — TrustTrader

**Audit status:** TrustTrader code lives in `C:/Users/Cash4/repos/trusttrader`
(per the project memory file `project_trusttrader_sprint.md`, dated 2026-04-07).
TrustTrader currently uses repid-engine for HAL/score events but does not pay for
them.

**What changes when HAL signals become x402-payable (Phase 3):**

1. TrustTrader's signal-fetcher hits `/api/v1/hal/signals` per BTC tick.
2. First 100 calls/day for SOPHIA (RepID 10000, AUTONOMOUS) are free × 100 = 10,000.
   At one signal/minute that's ~7 days of free coverage. Not a problem in practice.
3. Beyond quota: SOPHIA's wallet (per Section C) auto-pays $0.0005 (50% discount) per
   signal.
4. Each settled payment writes a `repid_score_events` row with `x402Context` populated
   and `economic_impact_usdc` set.

TrustTrader doesn't need to change beyond: (a) catch 402, (b) auto-pay using the
TrustShell wallet config from Section B.

---

## H) Insurance pool

**Status:** I did not find an existing `insurance_pool` or `treasury` table in the
AITrinitySymphony schema during the prior audit. Greenfield design — must be created
before this can route real funds.

**Math:**

```
fee_per_call = 0.05 × call_price        // 5% of every paid call
pool_address = INSURANCE_POOL_ADDRESS   // env var, on-chain wallet

for each settled x402 payment:
   primary_payout    = call_price - fee_per_call    →  resource server
   pool_payout       = fee_per_call                 →  insurance pool
```

The simplest implementation is to make the resource server's `payTo` an internal
splitter contract that fans out 95/5. If the facilitator supports multi-recipient
splits in `PaymentRequirements.accepts[].split = [...]`, use that instead — fewer
moving parts, single settlement.

**What the pool covers (out of scope for this doc, here for context):**

- Refunds on legitimate disputes (TrustEscrow arbitrations that find against seller).
- Reimbursement for hallucination-caused losses up to a cap, when the consuming agent
  was using the HAL signals via x402 (i.e. paid for the gate). Insurance is *only*
  available to paying users — that's the carrot.

---

## Open questions (carry into Phase 3 only after Sean signs off)

1. **Facilitator URL.** Coinbase's hosted Base-Sepolia facilitator URL was not
   surfaceable from public docs at audit time. Phase 3 will need either (a) a public
   URL Sean provides, or (b) a standup of `coinbase/x402`'s reference facilitator
   locally / on Railway as a separate service. Recommend the latter for
   reproducibility.

2. **Receiving address.** What wallet receives the engine's x402 income on Base
   Sepolia? Could be the existing Trinity Deployer wallet
   (`0xdf6b8215D193b11B4903d223729c3CF7A6de271d`) — but per the prior audit, that
   wallet's private key is in plaintext in trinity-ecosystem `.env.local` and
   committed to a script. Strongly suggest a separate fresh wallet for x402 receipts
   so the leaked-key risk doesn't compound.

3. **Scope of free quota — per RepID or per IP or per API key?** I've designed for
   per-RepID when an API key resolves to an agent, falling back to per-IP otherwise.
   Confirm.

4. **Should the paywall write to `repid_score_events` directly, or through `/score`?**
   Going through `/score` is cleaner (preserves audit/badges/decay) but means another
   internal HTTP hop. Direct write is faster but bypasses the FIXED_DELTAS table and
   could miss badges. Recommendation: direct insert with `event_type = 'X402_SETTLED'`
   added to the enum in `RepIdUpdateInput.eventType` and `FIXED_DELTAS` (delta = 0,
   non-scoring), so the row exists for audit but doesn't perturb the score.

5. **CLAUDE.md says SQL-keyword sanitizer rejects bodies containing `--`, `;`,
   `SELECT/...`.** Base64-encoded `PaymentPayload` strings will not contain SQL
   tokens, so the sanitizer is fine. But human-readable `description` fields in
   `PaymentRequirements.accepts[]` could contain `;`. The middleware must emit
   descriptions that avoid those tokens — flag for the implementation.
