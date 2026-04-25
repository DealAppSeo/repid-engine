# x402 Integration Map — Self-Critique

**Date:** 2026-04-24
**Companion to:** `docs/x402-INTEGRATION-MAP.md`
**Purpose:** Surface gaps in the original map *before* Phase 3 implementation, not
after. I'm being deliberately tough on my own work. Where the original map glossed
something, this critique names it. Where the original map made an assumption, this
critique asks the question that the assumption skipped.

**Format:** for each integration point in the original map, four headings —
- **Edge cases the original map didn't handle**
- **Failure modes that need explicit treatment**
- **Adversarial economic dynamics**
- **Open questions for Sean**

---

## A) repid-engine endpoints (paywall middleware)

**What the original map said:** Wrap `/api/v1/hal/signals` and others with
x402-express middleware, free-quota in Redis, RepID-tier discount math, 402
response per Coinbase spec, verify+settle via facilitator, write
`repid_score_events.x402Context`.

### Edge cases not handled

1. **Concurrent quota races.** Two parallel requests both hit "quota = 99 of 100"
   at the same time, both pass the check, both 200 — quota is breached by 1. The
   map says "Redis INCR" but doesn't specify INCR-then-check vs check-then-INCR.
   Atomicity not addressed.
2. **Redis cold-start after restart.** Quotas reset to 0 — a malicious agent
   bouncing the engine could re-grant itself a full free quota. Not addressed.
3. **Clock skew across instances.** `yyyymmdd` quota key assumes UTC consistency.
   Multi-region Railway deploys have skew. Not addressed.
4. **Quota for un-authenticated callers.** Map says "per RepID when API key
   resolves to an agent, falling back to per-IP otherwise." But the existing
   `/api/v1/hal/signals` is currently *no auth at all* — every caller is
   `per-IP`, which means a single attacker behind CGNAT or Cloudflare Workers can
   share a quota with millions of legit users.
5. **Free quota carryover across midnight.** Long-running batch jobs that span
   midnight UTC get half their quota at midnight. Behavior undefined.
6. **What happens when quota is negative?** A bug or admin override could leave
   quota in a negative state. The map doesn't say what the middleware does.
7. **Agents with `tier = null` or `tier = 'GENESIS'`.** The `tierLimits` table
   only has 3 entries. The handler defaults to `0` for unknown tiers, which is the
   safe default — but what if an agent newly created during the request has no
   tier yet? Race.
8. **Discount ceiling overflow.** `0.5 × (repId - 1000) / 9000` for `repId = 10000`
   is exactly 0.5, but for `repId = 10001` (shouldn't happen, but no DB constraint
   verified) the discount goes to 50.0006%. `clamp(0, 0.5, ...)` handles it.
   Mentioned that, OK.

### Failure modes needing explicit treatment

1. **Facilitator down.** Map assumes verify/settle calls succeed. What's the
   middleware's behavior when Coinbase's facilitator returns 5xx, hangs, or has a
   30-second cold start? Three options — fail-closed (reject payment, deny
   request, customer angry), fail-open (admit request, lose revenue), or queue
   (settle later, gives agent free request now). Not specified.
2. **Settlement succeeds but we crash before responding.** Money moved, agent
   never got the response. Need idempotent retry semantics. Not specified.
3. **Settlement fails after verify.** Verify said OK, settle failed. Did the
   agent get the response? If yes, we ate the cost. Not specified.
4. **Replay across endpoints.** Map says cache `payload.signature` in Redis with
   TTL `maxTimeoutSeconds × 2`. But signatures might be reusable across
   different `resource` URLs depending on how `PaymentRequirements.resource`
   binds the signed payload — need to read the spec carefully and confirm.
5. **Sanitizer collision with payment description.** Map flagged this. Doesn't
   specify how to surface a sanitizer-rejected response upstream — does the
   middleware return its own 400, or let the global sanitizer return its 400?
6. **Free quota query when agent has no `current_repid`.** Pre-genesis agents.

### Adversarial economic dynamics

1. **Sybil attack on free quota.** Cheap to register 100 agents, each gets 100
   free HAL calls/day = 10,000 free calls. The original `/api/v1/agents/register`
   is rate-limited 10/hr/IP, so 240/day per IP. With CGNAT or proxies, near-zero
   cost.
2. **Reputation farming for discount.** AUTONOMOUS tier (RepID 5000+) gets up to
   50% discount + 100× free quota. The cost of farming RepID to AUTONOMOUS may be
   less than the discount value over a usage horizon — turns the gate into a
   reputation-buying market.
3. **Discount inversion.** High-RepID agents pay LESS per call. But high-RepID
   agents are more economically capable (more trusted, more wallet activity).
   We're discounting the customers who can afford to pay. Backwards from a
   revenue-maximization standpoint. Defensible only if we believe it builds
   loyalty / network effects.
4. **Zero-cost CUSTODIED_DBT extraction.** A new agent has zero spend cap, so
   can ONLY use free quota. They get exactly the same price-per-call as a high-tier
   agent within their quota. No incentive to pay for anything until quota is hit.
5. **Race-to-the-bottom on facilitator fees.** PayAI vs Coinbase vs xpay vs
   self-host — we'd be optimizing per-call against fees. If we expose facilitator
   choice in the 402 response (multi-`accepts`), agents pick cheapest, leaving
   our preferred facilitator under-utilized.

### Open questions for Sean

1. Authoritative quota source — Redis (fast, ephemeral) or DB (durable, slow)?
   Or both with periodic reconciliation?
2. Failure mode policy: fail-closed or fail-open on facilitator outage?
3. Should free quota expire at end-of-UTC-day, or be a 24-hour sliding window?
4. Acceptable quota miss rate from race conditions: 0% (Lua-script atomicity), or
   <1% acceptable?
5. Anti-Sybil strategy: per-IP quota AND per-RepID quota? Per-conservator quota?
6. Is the discount slope correct? Should it actually be **inverted** (high-RepID
   pays MORE because they extract more value)? Or split — high-RepID pays less
   per call but with higher daily ceilings?

---

## B) trustshell npm package (auto-pay)

**What the original map said:** Add a `wallet` config to `TrustShellConfig` with
`maxAutoPayUSDC` and `dailyAutoPayCapUSDC`. Default OFF. On 402, decode, sign,
retry with `PAYMENT-SIGNATURE`. Surface settlement in result.

### Edge cases not handled

1. **Stale `engineUrl`.** If trustshell has a hardcoded default
   (`https://repid-engine-production.up.railway.app`) and the engine moves, every
   pre-deployed agent breaks. Map didn't address SDK-side discovery / re-pointing.
2. **Auto-pay during retry storms.** A failing engine returns 402 repeatedly;
   trustshell auto-pays each one; agent's wallet drains during the retry loop.
   Map doesn't specify "don't pay if the previous attempt's payment didn't unlock
   the response."
3. **Network mismatch.** SDK is configured for `base-sepolia`, engine emits a 402
   accepting `solana-devnet`. Currently undefined behavior.
4. **Wallet connection lost mid-call.** `evaluate(text, certainty)` is async; the
   wallet provider could disconnect between local HAL and the auto-pay step.
5. **Multiple `accepts` options.** A 402 with three options — base-sepolia,
   base-mainnet, solana — which does the SDK pick? Cheapest? First listed?
   Configurable preference order? Map didn't say.
6. **Insufficient wallet balance.** Currently no spec for what the SDK returns —
   throws? Returns `{paid: false, reason: 'insufficient_balance'}`? Falls through
   silently?

### Failure modes needing explicit treatment

1. **Daily cap mid-call.** `dailyAutoPayCapUSDC: 5.00`, agent has spent 4.99,
   next call costs $0.01. Tied bid: pay or not?
2. **Race between two parallel `evaluate()` calls.** Both check daily cap,
   both pass, both pay — cap breached by one call's worth.
3. **Browser context vs Node context.** SDK targets both. `crypto.randomUUID()`,
   `fetch`, wallet libraries differ. Today's v0.1.0 only uses `fetch` and
   `EventEmitter`; adding a wallet (viem) breaks browser builds without
   careful tree-shaking.
4. **Auto-pay enabled while user is asleep / offline.** Wallet stored
   server-side or on-device? Map said "SDK never holds keys" — but how does
   auto-pay sign a transaction without the user present?
5. **Bundling cost.** `viem` is ~80KB minified. `@coinbase/wallet-sdk` is
   bigger. Does this bloat trustshell from its current ~5KB to 100KB+? If so,
   should auto-pay be a separate package (`@hyperdag/trustshell-wallet`)?

### Adversarial economic dynamics

1. **Front-running auto-pay.** If a malicious caller knows our agent's wallet
   address and the per-call price, they can monitor the mempool and front-run
   USDC transfers — but x402 settlement is direct facilitator-mediated, not
   AMM-based, so this is mostly mitigated. Still worth confirming.
2. **Caller forces 402 to drain agent wallet.** A man-in-the-middle could
   replace any 200 with 402 PAYMENT-REQUIRED to a fake `payTo` address. If the
   SDK auto-pays without verifying TLS / facilitator signature, we lose money to
   the attacker. Need: TLS verification + facilitator signature on 402 response.
3. **Replay across endpoints.** SDK signs `PaymentPayload` for `resource =
   /api/v1/hal/signals`; if the spec doesn't bind signature to resource path,
   the signature can be replayed against `/api/v1/prove-repid`.

### Open questions for Sean

1. Browser-side, server-side, or both for auto-pay? Each implies a different
   wallet model.
2. Is `engineUrl` static-default or fetched from a discovery endpoint?
3. Where do we publish `@hyperdag/trustshell-wallet` — same npm scope, or
   separate? Affects auto-pay surface area.
4. Should auto-pay require an explicit user-confirmed `walletApproveAuto()`
   handshake before the SDK ever signs anything?

---

## C) Agent wallets (HKDF derivation)

**What the original map said:** Non-custodial; derive
`agent_signing_key = HKDF-SHA256(user_master_key, salt = "hyperdag/agent/v1/" +
agent_id, info = "x402-payments")`.

### Edge cases not handled

1. **Master key rotation.** If the user rotates their master key (lost device,
   compromise), all derived agent keys change. The agents' on-chain wallet
   addresses change. The settled payments from the old keys → orphaned funds in
   addresses no one can sign for anymore.
2. **Cross-device determinism.** HKDF is deterministic but only if both devices
   have the same master key. Mobile-vs-desktop sync is not addressed.
3. **`agent_id` format change.** `agent_id` is currently a UUID, but the
   `repid_agents` table also has `erc8004_address` and `agent_name`. If we ever
   migrate `agent_id` to a different scheme, all derived keys break.
4. **Master key never created.** New users have no master key yet. What does
   the SDK do? Bootstrap-and-derive on the fly, or refuse to start?
5. **Domain separation collision.** `salt = "hyperdag/agent/v1/" + agent_id`
   and `info = "x402-payments"` — what if a future feature wants
   `info = "x402-receipts"`? Need a versioned, documented separation policy.

### Failure modes needing explicit treatment

1. **Key derived but on-chain address mismatch.** Engine has stored
   `erc8004_address = "external:<uuid>"` for an agent that pre-dates the wallet
   derivation. SDK derives a real address, doesn't match what's in the DB.
   Reconciliation strategy not specified.
2. **HKDF parameters change.** If we ever bump from `v1` to `v2` in salt,
   migration path?
3. **The user's master key entropy is bad.** HKDF output is no better than
   input. If master keys are derived from passwords without proper KDF, all
   agent keys are weak.

### Adversarial economic dynamics

1. **Compromise of one agent leaks domain separation.** With one agent's
   `(salt, info, output_key)`, an attacker can confirm the salt scheme but can't
   derive the master key (HKDF is one-way). However: combined with a brute-force
   attack on the master key, the attacker can verify candidate master keys
   instantly. So master keys must remain high-entropy.
2. **Service-side derivation = de-facto custody.** If the engine ever derives
   the agent key for the user (e.g. for a server-side trustshell bundle), that's
   custodial in practice even if non-custodial on paper.

### Open questions for Sean

1. Master key storage: Privy, browser WebAuthn, hardware wallet, MPC, KMS? Each
   has different recovery semantics.
2. Key rotation: do we ever rotate? If yes, migration path. If no, document
   "lose master key = lose all agent wallets" plainly.
3. Recovery: paper backup, social recovery, custodian fallback?
4. Phase 3 reference impl uses an injected dev key — what does the integration
   test look like that proves the production HKDF derivation works?

---

## D) RepID gating mechanics (per-call discount + free quota + spend cap)

**What the original map said:** Three dimensions vary by tier — discount,
free-quota multiplier, daily spend cap.

### Edge cases not handled

1. **Tier change mid-call.** Between paywall pre-check and settlement, the
   agent's RepID could move — e.g. a concurrent score event flips
   AUTONOMOUS → EARNING_AUTONOMY. Discount mismatched.
2. **Cap reset semantics.** Daily caps reset at UTC midnight, but "daily" is
   ambiguous. Sliding 24-hour window vs calendar day.
3. **Cap applies to attempted or settled spend?** If a payment fails to settle,
   does the attempt still count against the daily cap? Could be exploited by
   attackers to lock an agent out by triggering failed settlements.

### Failure modes needing explicit treatment

1. **Quota & discount derived from different tier snapshots.** Quota lookup at
   request start, discount calculated at 402-emit — same RepID? Need to
   document.
2. **Misconfigured base price.** A typo in `base(endpoint)` (e.g. $1.00 instead
   of $0.001) plus 50% discount is still $0.50 — agents drained faster than
   expected.
3. **Cap arithmetic in Redis as floats.** USDC has 6 decimals; storing as float
   causes precision loss. Should be integer microUSDC.

### Adversarial economic dynamics

1. **AUTONOMOUS-tier botnet.** If an attacker builds 1000 farmed AUTONOMOUS
   agents, each with $1000/day spend cap, they have $1M/day legitimate-looking
   spend. Could be used for laundering, wash-trading, or reputation laundering
   downstream.
2. **Discount griefing.** A malicious agent could *deliberately* lower its own
   RepID to confuse pricing oracles or evade discount-related fraud detection.
3. **The cap as a target.** Knowing the cap exposes the maximum economic damage
   per agent per day. A jail-breaking exploit that gets HAL-vetoed responses is
   bounded by the daily cap; making the cap public bounds the attacker's
   model-extraction budget too.

### Open questions for Sean

1. Tier-snapshot policy: lock at request start, or allow mid-call changes?
2. Is the daily cap a hard ceiling or soft (alert + continue)?
3. Is the cap public (transparent), private (security), or per-tier-public-but-
   per-agent-private?
4. When an attempt fails, does it count against cap?

---

## E) PROJECTED — TrustMarket.dev

**What the original map said:** Marketplace gateway, x402 with split (90/5/5),
seller listed only if RepID ≥ 1000, post-tx scoring update.

### Edge cases not handled

1. **Multi-recipient split mechanics.** Map said "if facilitator supports
   multi-recipient splits". I do NOT know if Coinbase's CDP facilitator supports
   splits. If not, we settle to ourselves and fan out — which means we're a
   money-transmitter for the fan-out leg. Major regulatory implication.
2. **Cross-network listings.** Buyer on Solana, seller on Base. Atomic swap?
   Bridged USDC? Not addressed.
3. **Disputed deliveries.** Seller endpoint returns garbage; buyer demands
   refund. Map references TrustEscrow but doesn't specify the trigger flow from
   marketplace to escrow.

### Failure modes needing explicit treatment

1. **Seller endpoint times out.** Buyer paid, seller endpoint never responds.
   Refund? Re-attempt? Marketplace charges anyway?
2. **Marketplace operator is liability surface.** All payments flow through us
   (or our gateway). Any KYC/AML / OFAC compliance issues land on us, not the
   protocol.

### Adversarial economic dynamics

1. **Wash-trading reputation.** Two colluding agents repeatedly buy from each
   other to inflate transaction count, which inflates RepID. Score model needs
   counterparty-diversity weighting (CRI paper does this — see novelty audit).
2. **Listing extraction.** Anyone can list anything; quality control is binary
   (RepID ≥ 1000). A malicious AUTONOMOUS-tier agent can list malware-as-a-service.
3. **Race-to-the-bottom pricing.** If buyer auto-pays cheapest matching listing,
   sellers undercut to zero margin and quality collapses.

### Open questions for Sean

1. Are we the marketplace gateway, or are we infrastructure for *someone else's*
   gateway? Massive regulatory difference.
2. Is TrustMarket a real near-term product, or aspirational? Greenfield design
   in the original map suggests aspirational; should we even be designing this
   now?
3. Listing-quality moderation policy?

---

## F) PROJECTED — TrustEscrow

**What the original map said:** x402 delayed settlement; lock funds, release on
trigger, refund on timeout. Arbiter weighted by RepID.

### Edge cases not handled

1. **Does x402 actually support delayed settlement?** I claimed it does. Need to
   verify against current spec — vanilla `exact` scheme settles immediately. A
   "lock" semantics may require a separate facilitator capability or out-of-band
   custody.
2. **Multi-arbiter quorum.** Mentioned RepID-weighted BFT — but how is the
   arbiter selection seeded, who can challenge? Sybil-resistant?
3. **Timeout semantics.** Who wins on timeout — buyer (refund) or seller
   (auto-release)? Default needs to be specified per use case.

### Failure modes needing explicit treatment

1. **Arbiter offline.** If the arbiter is a single agent and it's down, escrow
   is stuck. Need quorum + tiebreaker rules.
2. **Conflicting arbitration outcomes.** Two arbiters say release, one says
   refund. RepID-weighted vote — but if one of the "release" arbiters has
   massive RepID, do they always win?
3. **Funds stuck if arbiter dies before timeout.** Funds frozen permanently?

### Adversarial economic dynamics

1. **Arbiter bribery.** Whoever can bribe the highest-RepID arbiter wins.
   RepID-weighting concentrates power.
2. **Long-tail liquidity drain.** Funds locked in escrow are unavailable for
   trading. Heavy escrow use during a market crash compounds the crash.

### Open questions for Sean

1. Is TrustEscrow a real near-term product? Same question as TrustMarket — if
   it's aspirational, are we over-designing this map?
2. Custody model for locked funds — on-chain time-lock, multisig, facilitator-
   custodial?

---

## G) PROJECTED — TrustTrader (HAL signal payments)

**What the original map said:** TrustTrader's signal-fetcher hits
`/api/v1/hal/signals` per BTC tick; first 100 calls/day for SOPHIA × 100×
multiplier = 10,000; auto-pay $0.0005 beyond. Each settled payment writes a
`repid_score_events` row.

### Edge cases not handled

1. **TrustTrader currently has no wallet.** The HAL paywall would break
   TrustTrader's signal-fetcher overnight unless wallet bootstrap is
   coordinated.
2. **Free-quota math doesn't add up.** AUTONOMOUS tier "100× multiplier" applied
   to "100/RepID" base = 10,000/day. At one signal/min that's ~7 days. But
   TrustTrader is documented to fetch 13 signals (per memory), so 13 × 24 × 60 =
   18,720 calls/day — quota busted in <13 hours, not 7 days.
3. **Signal fetcher might be rate-limited upstream by CoinGecko/PRISM** before
   it ever hits our HAL endpoint. Quota math is an upper bound.

### Failure modes needing explicit treatment

1. **HAL down → no trading.** TrustTrader needs HAL to gate every trade. Engine
   downtime = trading halt. Need a fallback (cache last signal, run with
   degraded confidence, or pause trading).
2. **Quota exhausted during volatility spike.** Highest-value moments to be
   trading are exactly when signals are most needed; quota exhausting at the
   wrong moment is worst-case.

### Adversarial economic dynamics

1. **HAL gates the trader's edge.** If TrustTrader's competitive advantage
   comes from HAL signals, a competitor could buy HAL signals from us at a
   discount and front-run us. The free quota disclosure (in 402 response
   `extra.freeQuotaRemaining`) leaks usage patterns.
2. **Constitutional veto = loss-of-revenue event.** If HAL vetoes a trade,
   TrustTrader takes a non-trade. Sean could claim that's protective; from a
   trader's POV it's lost upside.

### Open questions for Sean

1. Is TrustTrader's signal fetcher SOPHIA, or a different agent?
   Determines wallet derivation.
2. What's the policy when HAL is unavailable? Trade or don't?
3. Free-quota disclosure in 402 response — leak it or not?

---

## H) Insurance pool (5% facilitator-fee allocation)

**What the original map said:** 5% of every paid call to an
`INSURANCE_POOL_ADDRESS`, via splitter contract or facilitator-side split. Pool
covers refunds + hallucination losses.

### Edge cases not handled

1. **Pool capitalization curve.** At $0.001/call × 5% = $0.00005 per call. To
   reach a $10K pool, 200M calls needed. At launch volume, pool is empty for a
   long time. Insurance promise undeliverable until critical mass.
2. **Pool denomination.** All USDC, or diversified? USDC depeg risk.
3. **What constitutes an "insured loss"?** Burden of proof? Self-attested?
   Externally-audited? Map said "hallucination-caused losses up to a cap" but
   no proof model.
4. **Counterparty-claim model.** If consumer A sues consumer B for damages and
   wants insurance to pay — does the pool cover that? Or only first-party losses?

### Failure modes needing explicit treatment

1. **Splitter contract bug.** Multi-recipient settlement requires either
   facilitator-side support (uncertain) or a custom splitter contract (audit
   surface). Bug = funds lost.
2. **Pool drained by a single big claim.** No reinsurance / cap layer specified.
3. **Pool address compromised.** Single-key wallet for pool funds is a
   single-point-of-failure. Need multisig or contract-controlled.

### Adversarial economic dynamics

1. **Claim farming.** Fake hallucination losses claimed against the pool. If
   self-attested, free money. If externally-audited, audit cost > claim value
   for small amounts → only big claims rational, which drains pool faster.
2. **Refusal-to-cover incentive.** Pool operator (us, presumably) has economic
   incentive to deny claims. Trust-eroding.
3. **Withdraw-and-grief.** Insured user paid into pool; pool denies claim;
   user trash-talks publicly; high-RepID agents leave; revenue collapse.

### Open questions for Sean

1. Pool governance: us (centralized), DAO, or arbitration committee?
2. Insurance-claim adjudication process: BFT vote? Trinity-ecosystem BFTEngine?
3. Is the 5% rate fixed, or adjustable per network conditions?
4. Does the pool issue an SBT/NFT receipt to insured callers as proof of
   coverage at time of call?

---

## Cross-cutting questions Sean should answer before Phase 3

1. **Which products in the map are real near-term, vs aspirational?** If
   TrustMarket and TrustEscrow are 6-12 months out, designing them now is mostly
   storytelling. The Phase 3 implementation needs to be solid for the *real*
   near-term product (HAL signals paywall) — that's it.
2. **Regulatory posture.** A money-transmitter analysis is non-optional once
   we touch settlement splits, escrow custody, or insurance pools. Have we
   talked to a fintech lawyer?
3. **The discount slope.** I claimed AUTONOMOUS pays less. Is that the actual
   business model, or should pricing be flat / inverted?
4. **Free-quota disclosure.** Map exposes `freeQuotaRemaining` in the 402
   response. Could be useful for clients, leaks usage patterns. Hide?
5. **Sybil model.** What's the cost of becoming AUTONOMOUS for an attacker, vs
   the value of the discount + cap? If attacker-cost < attacker-benefit, system
   is exploitable. Need a numerical answer.

## What I would do if I were redoing the original map

1. **Halve the scope.** Skip TrustMarket / TrustEscrow / TrustTrader sections —
   they're aspirational and dilute focus.
2. **Add a "threat model" section** — explicit list of attackers, capabilities,
   and what the design defends against / accepts.
3. **Add concrete numbers.** Every claim like "discount up to 50%" should
   include a worked example showing the dollar flows for an example month.
4. **Add a "phase 3 cut-line"** — what's in scope for the reference impl, what's
   explicitly out. The current map blurs this.
