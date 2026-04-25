# Phase 3 Decisions Needed

**Date:** 2026-04-24
**Audience:** Sean
**Purpose:** Three decisions that block Phase 3 implementation. Each has options,
tradeoffs, a recommendation, and a one-paragraph "what changes in Phase 3" note.

Companion docs:
- `docs/x402-CURRENT-STATE.md` — what exists today
- `docs/x402-INTEGRATION-MAP.md` — the forward design
- `docs/x402-INTEGRATION-MAP-CRITIQUE.md` — gaps in that design
- `docs/x402-NOVELTY-AUDIT.md` — patent posture

---

## Decision 1 — Facilitator URL

### Question

Which x402 facilitator does the HAL paywall middleware POST `/verify` and
`/settle` against on Base Sepolia (testnet) and, eventually, Base mainnet?

### Options

#### Option A — Coinbase CDP hosted

- **URL:** `https://api.cdp.coinbase.com/platform/v2/x402`
- **Network params:** `eip155:84532` (Base Sepolia), `eip155:8453` (Base mainnet)
- **Auth:** Coinbase Developer Platform (CDP) API keys for some operations.
- **Cost:** "Fee-free USDC settlement on Base mainnet" per Coinbase docs.
- **Operated by:** Coinbase (production infra, monitoring, redundancy).
- **Pros:** Zero ops on us. Production-grade. The canonical facilitator most x402
  clients will already trust. Same facilitator the spec authors run, so spec
  drift = lowest.
- **Cons:** Vendor dependency on Coinbase. If their facilitator has an outage,
  every paid call to our engine fails. CDP API key requirement adds another
  secret to manage.

#### Option B — PayAI hosted (the one create-8004-agent uses)

- **URL:** `https://facilitator.payai.network`
- **Network support:** Solana, EVM (including Base Sepolia).
- **Auth:** "No API keys" per docs.
- **Pros:** No API key management. Multi-chain (covers Solana if/when relevant).
  Used by `create-8004-agent` already, so consistent with the canonical
  ERC-8004 reference CLI.
- **Cons:** Smaller operator. Less battle-tested at scale than Coinbase. We'd be
  taking dependency on a less-known vendor for a production payment path.

#### Option C — Self-host

- **URL:** internal, e.g. `https://x402-facilitator.repid-engine-internal.up.railway.app`
- **Source:** clone `coinbase/x402` reference facilitator.
- **Pros:** Full control. No vendor risk. Same code Coinbase runs.
- **Cons:** Real ops surface. We need a wallet with funds for settlement gas.
  Monitoring, alerting, on-call. Defeats the "use the facilitator" simplification
  — we'd be running the thing we set out to abstract over.

#### Option D — Multi-facilitator (`accepts` array)

- Emit multiple `accepts` options in 402 response — Coinbase + PayAI + maybe a
  self-hosted fallback. Client picks.
- **Pros:** Resilience to single-facilitator outage. Lets agents pick by
  cost/speed.
- **Cons:** Spec compliance burden — need to test against multiple facilitators.
  Splits revenue tracking across facilitators. Increases the test matrix.

### Tradeoffs at a glance

| | Vendor risk | Ops burden | Revenue drag | Agent UX | Spec drift |
|---|---|---|---|---|---|
| A: Coinbase | High (single vendor) | None | Lowest (their "free" claim) | Best | Lowest |
| B: PayAI | Medium | None | Unknown | Good | Low |
| C: Self-host | None | High | Gas costs eat into us | OK | Low |
| D: Multi | Low | Medium | Mixed | Best | Medium |

### Recommendation

**Option A for Phase 3 reference impl + Option B as fallback in config.**
Concretely:

```ts
const FACILITATOR_URLS = {
  primary: process.env.X402_FACILITATOR_PRIMARY
    ?? 'https://api.cdp.coinbase.com/platform/v2/x402',
  fallback: process.env.X402_FACILITATOR_FALLBACK
    ?? 'https://facilitator.payai.network',
};
```

Phase 3 implements Coinbase as primary because (a) it's the canonical operator and
(b) "fee-free USDC settlement on Base mainnet" is the right marginal-cost story.
PayAI as fallback handled by middleware retry on 5xx. Skip multi-`accepts` until
we have evidence the primary is actually flaky.

**Reject Option C** unless there's a regulatory or sovereignty reason to self-host
that I'm missing — running our own facilitator triples the ops surface for no
clear win on Phase 3.

### What changes in Phase 3 implementation depending on this answer

- **A:** Need a CDP API key. Sean creates/manages it; goes in Railway env as
  `CDP_API_KEY` (and `CDP_API_KEY_SECRET` if needed). Middleware reads
  facilitator URL from env, POSTs verify/settle with bearer auth header.
- **B:** No API key. Middleware just POSTs to PayAI URL. Simpler config.
- **C:** Add a new repo / Railway service for the facilitator. Provision its own
  wallet with seed funds for gas. Big sub-sprint.
- **D:** Middleware emits `accepts: [...]` with 2-3 entries. Test matrix
  grows; settlement bookkeeping becomes per-facilitator.

---

## Decision 2 — Receiving wallet

### Question

What wallet receives USDC payments from x402 settlements on Base Sepolia? Where
does its private key live?

### Options

#### Option A — Reuse Trinity Deployer wallet

- **Address:** `0xdf6b8215D193b11B4903d223729c3CF7A6de271d`
- **Key location today:** plaintext in `trinity-ecosystem/.env.local` AND
  hardcoded in `register-agents-erc8004.js` (per prior ecosystem audit).
- **Pros:** One wallet to manage. Already funded for testnet ops.
- **Cons:** **Private key is leaked.** It's in a plaintext .env file and
  committed inline in a JS script. Reusing it for x402 income compounds the
  risk — every settled payment now lands in a known-compromised wallet. Hard
  no.

#### Option B — Fresh dedicated wallet, key in Railway env var

- **Address:** newly generated. Sean controls.
- **Key location:** `X402_RECEIVE_PRIVKEY` in Railway env (or
  `X402_RECEIVE_ADDRESS` only if facilitator pulls — receive-only addresses
  don't need keys for receiving, only for spending).
- **Pros:** Clean break from leaked-key risk. Dedicated audit trail.
- **Cons:** Need to generate, fund (for any spending), back up. Railway env vars
  are fine for testnet but a single point of failure for mainnet.

#### Option C — Fresh wallet, key in HSM / KMS

- **Address:** newly generated.
- **Key location:** AWS KMS, GCP KMS, or a hardware HSM.
- **Pros:** Best practice for production. Audit-loggable signing.
- **Cons:** Overkill for testnet. Adds a paid dependency. Complicates dev
  workflow.

#### Option D — Multi-sig

- **Address:** Safe (Gnosis Safe) on Base Sepolia, 2-of-3 with Sean +
  conservator + cold key.
- **Pros:** Secures the funds against single-key compromise.
- **Cons:** Settlement to a Safe address works for receiving USDC fine, but
  if the engine ever needs to *spend* received funds (e.g. fee distribution,
  refund payouts, insurance pool), Safe transactions need offline signing
  ceremony. Slow.

### Tradeoffs at a glance

| | Security | Setup cost | Spending UX | Fits Phase 3 |
|---|---|---|---|---|
| A: Trinity Deployer | **Bad — leaked key** | None | OK | No |
| B: Fresh + Railway env | OK for testnet | Minutes | OK | **Yes** |
| C: HSM/KMS | Best | Hours-days | OK | Overkill |
| D: Multi-sig Safe | Best for receiving | ~1hr | Bad for spending | Receive-only OK |

### Recommendation

**Option B for Phase 3, but receive-only — no spending key on the engine.**
Concretely:

1. Generate a fresh wallet locally (Sean does this; viem `generatePrivateKey()`
   + `privateKeyToAccount()`). Save the address. Save the private key in 1Password
   or equivalent.
2. Engine config gets only `X402_RECEIVE_ADDRESS` — no private key on the engine.
   The engine emits this address as the `payTo` field in 402 responses. The
   facilitator settles USDC to it. No engine-side signing is needed for *receiving*.
3. The private key stays offline / in cold storage. We reach for it only when we
   actually need to move funds out (fee distribution, insurance pool top-up,
   etc.) — which is a deliberate, audited operation, not part of the request
   path.

This sidesteps the "where does the key live" question entirely for Phase 3 by
not needing the key on the request path. Spend-side custody is a follow-up
sprint.

**For mainnet:** upgrade to Option C (KMS) or Option D (Safe). Don't put a
mainnet private key in a Railway env var.

### What changes in Phase 3 implementation depending on this answer

- **A:** I refuse to recommend this. It would require accepting the leaked-key
  compounding risk. Don't do it.
- **B:** Add `X402_RECEIVE_ADDRESS` to engine env. Middleware injects it as
  `payTo` in 402 response. Done.
- **C:** Need a KMS integration in the engine (or in the facilitator if
  self-hosted). Substantial sub-sprint, not Phase 3 scope.
- **D:** Same as B for receiving (Safe address works as `payTo`). Spending
  becomes a separate ceremony.

---

## Decision 3 — `X402_SETTLED` event-type integration

### Question

When the paywall middleware successfully settles a payment, should it write a
row to `repid_score_events` with a new `event_type = 'X402_SETTLED'`?

If yes — does this event affect RepID score, or is it audit-only?

### Options

#### Option A — Don't write any event

- Middleware logs the settlement to a separate ops log; doesn't touch
  `repid_score_events`.
- **Pros:** Zero blast radius into the existing scoring pipeline. Clean
  separation of payment plumbing from reputation logic.
- **Cons:** Audit gap. We can't reconcile "agent X's reputation events" with
  "agent X's payment activity" through one log. Loses the
  payment-context-as-reputation-input idea (Pattern 3 of the novelty audit).

#### Option B — Write event, delta = 0 (audit-only)

- New event type `X402_SETTLED` added to `RepIdUpdateInput.eventType` enum and
  `FIXED_DELTAS` table with delta = 0.
- Carries `x402Context` populated (agent ID, paymentAmount, currency,
  x402RequestId, settlement tx hash).
- **Pros:** Single source of truth (`repid_score_events`) for everything that
  happened to the agent. Doesn't perturb the score. Doesn't trigger
  badges/decay (delta = 0 means decay/redemption math runs but produces no
  change beyond decay-of-score-from-time-passed).
- **Cons:** Goes through the full `updateRepId(...)` pipeline including
  constitutional audit + ecosystem-need lookup, which is wasted work for an
  audit-only event. Could shortcut by inserting to `repid_score_events`
  directly, bypassing `updateRepId(...)` — but then we lose the audit-trail
  consistency.

#### Option C — Write event with positive delta (reputation-rewarded)

- Each settled payment slightly increases RepID. E.g. delta = +1, scaled by
  `economic_impact_usdc`.
- **Pros:** Encourages payment activity ("paying customers are good
  reputation"). Aligns reputation with economic skin-in-the-game (echoes the
  x402 reputation registry pattern).
- **Cons:** Trivially gameable — agent floods the system with self-payments to
  pump score. CRI paper warns about exactly this.

#### Option D — Write event with delta determined by HAL outcome of paid call

- Settlement event delta depends on whether the paid call's HAL signals showed
  hallucination (negative delta) or were clean (slight positive).
- **Pros:** Couples reputation to actual quality of behavior, not just spend.
- **Cons:** Complex. Requires the settlement event to know the HAL result of
  the call it paid for — coupling between paywall middleware and the route
  handler that produced the response.

### Tradeoffs at a glance

| | Audit completeness | Score safety | Implementation cost | Gameability |
|---|---|---|---|---|
| A: Don't write | Bad | Best | Lowest | None |
| B: Audit-only delta=0 | Best | Best | Medium | None |
| C: Reward-based | Best | Bad | Medium | High |
| D: HAL-coupled delta | Best | Good | High | Low |

### Recommendation

**Option B (audit-only) for Phase 3.** Concretely:

1. Add `'X402_SETTLED'` to `RepIdUpdateInput.eventType` union in
   `src/engine/repid-update.ts:11-17`.
2. Add `X402_SETTLED: 0` to `FIXED_DELTAS` in `src/engine/repid-update.ts:65-69`.
3. Paywall middleware, after successful settlement, calls
   `updateRepId({agentId, eventType: 'X402_SETTLED', x402Context: {...}})` —
   reuses the existing pipeline. No special-casing.
4. The ecosystem-need weight for `X402_SETTLED` defaults to 1.0 (no boost).
5. The `economic_impact_usdc` column on `repid_score_events` (already exists,
   confirmed via prior schema query) is set to the settled amount.
6. No badge logic changes — `checkAndAwardBadges` is non-blocking and shouldn't
   fire for delta-0 events; verify in implementation.

**Why not C or D:** C is gameable. D is the right *aspirational* design but
requires state-passing between paywall middleware and route handlers that
isn't there today and shouldn't be added in Phase 3 (CLAUDE-RULE-3: Fix only
what's named). Document D in INTEGRATION-MAP as a Phase 4 follow-up.

### What changes in Phase 3 implementation depending on this answer

- **A:** Middleware writes only to a separate ops log (e.g.
  `trinity_agent_logs` with `action = 'x402_settled'`). No changes to
  `repid-update.ts`. Smallest blast radius.
- **B:** Two-line change to `repid-update.ts` enum + `FIXED_DELTAS`. Middleware
  calls `updateRepId(...)` after settle. Reuses existing audit trail.
- **C:** Same as B but with positive delta — risky, recommend against.
- **D:** Substantial new wiring. Out of scope for Phase 3.

---

## Summary — what to do once Sean answers these

Once Sean responds with three decisions, Phase 3 looks like:

| Decision | Effect on Phase 3 |
|---|---|
| 1 (Facilitator) | Sets `X402_FACILITATOR_URL` env, dictates auth model |
| 2 (Wallet) | Sets `X402_RECEIVE_ADDRESS` env, no engine signing |
| 3 (Event) | Two-line addition to `repid-update.ts`; middleware calls it |

If recommendations (A=Coinbase / B=fresh receive-only / B=audit-only delta-0) are
accepted, the Phase 3 sprint is:

1. Branch `feat/x402-hal-signals-paywall` from `origin/main`.
2. `npm install --legacy-peer-deps x402-express @coinbase/x402` (or whatever
   the actual current package names are — confirm at install time, the
   ecosystem is split between scoped and unscoped).
3. New `src/middleware/x402.ts` (paywall) + `src/services/x402-quota.ts`
   (Redis quota tracker). Both additive, no edits to existing handlers.
4. Wire on `/api/v1/hal/signals` only. Keep `/x402-gate` untouched.
5. Add `'X402_SETTLED'` to event enum + FIXED_DELTAS in `repid-update.ts`.
   Middleware calls `updateRepId(...)` after settle.
6. Add `GET /api/v1/hal/signals/pricing` returning current pricing JSON.
7. Tests in `tests/x402-hal.test.ts` (the directory jest actually runs).
8. README update under "x402 supported endpoints".
9. Push, open PR, do NOT merge.

Estimated time once unblocked: 1-2 days for a working reference impl on Base
Sepolia. Mainnet readiness is a separate gate (KMS / Safe upgrade).
