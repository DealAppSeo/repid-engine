# Audited E2E — negotiated A2A exchange, settled and anchored on-chain
**Run:** 2026-07-31 22:0x–22:5x PDT · **Chain:** Base Sepolia (84532) · **DB:** `qnnpjhlxljtqyigedwkb` (production)
**Verdict: the full loop executed for real. 17/17 assertions, plus the ERC-8004 anchor confirmed independently on-chain.**

Nothing here is simulated. Every row is in production Supabase; every transfer is a confirmed Base Sepolia transaction. Where a leg could not run, it is recorded as NOT RUN.

## The loop, with receipts

| # | stage | evidence |
|---|---|---|
| 1 | Buyer posts an RFQ | `a2a_rfqs` row, `verification`, reserve $0.01–$0.20 |
| 2 | **Two providers bid at different prices** | trinity-veritas $0.12/600s · trinity-w3c $0.10/900s |
| 3 | Buyer awards the cheaper bid | award `46549940-…`, contract `97c2d308-…`, created **atomically** by `a2a_accept_and_award` |
| 4 | Price provenance | `contract.agreed_price_usdc_raw == award.awarded_price_usdc_raw == winning round price` = 100000 raw. **The accept request contains no price field at all.** |
| 5 | Losing bid retained | `a2a_bids` statuses = `accepted, lost` |
| 6 | **Escrow AUTHORIZES, does not pay** | `payment_state=AUTHORIZED_NOT_SETTLED`, `x402_settlements.status='authorized'`, `tx_hash=NULL`, provider balance unchanged at 2.9000 USDC |
| 7 | Provider delivers | contract → `fulfilled` |
| 8 | **Buyer accepts → money moves** | settle tx [`0x588f905a…`](https://sepolia.basescan.org/tx/0x588f905a63baf5af32e898175eba54b067afa2514ae77b222eb879f68c442202) block 44896331 status=1 |
| 9 | On-chain effect verified at the settled block | provider **2.9000 → 3.0000 USDC** (+0.1000) |
| 10 | Ledger matches chain | `status='settled'`, `is_simulated=false`, `tx_hash` recorded |
| 11 | RepID moves both sides | provider 1613→1672 (`SERVICE_FULFILLED` +10, `SERVICE_SATISFIED` +29) · buyer 2027→2056 (+5, +14). 10 `repid_score_events` rows |
| 12 | **ERC-8004 anchor** | [`0x585f4b80…`](https://sepolia.basescan.org/tx/0x585f4b807f4778750d9c0d5195e4c082363d51e8c7651135a5fa6badb8dbee73) block 44897662, SUCCESS, gas 134,661, `from` `0xb2426888…7382` → `to` `0x8004B663…8713` (ReputationRegistry), `repid_value=1701` |

Lifetime ERC-8004 writes **72 → 73**. The previous one was 2026-07-23 — dormant nine days, for the reason in §3.

## 1. Protections that refused to be bypassed

Recorded because a demo that disables its own safety rails proves nothing.

- **`425 sealed_until_close`** — the default `sealed_close` mode refuses any award before `bids_close_at`. Not overridden; the run used `award_mode='immediate'`, a first-class mode frozen at RFQ creation and shown to every bidder.
- **`window_too_short`** — a minimum 1-hour bidding window is enforced. The window was widened to comply. A short window is exactly how a buyer opens and closes an auction before honest competitors can see it.
- **`operator_key_forbidden`** — every negotiation write requires an agent-bound key. Operator keys carry no binding and are refused.
- **Buyer-only release** — `/satisfy` refuses an unbound caller, a caller that is the provider, and a caller that is not the buyer.

## 2. Defects this run found (all fixed except where noted)

**a. The negotiation router was mounted PRE-auth.** A probe with a deliberately bogus key received the router's own error instead of a 401 — every negotiation endpoint was unauthenticated, so anyone could have bid as anyone. It had been mounted beside the marketplace routers, which are deliberately public. Moved behind `authMiddleware`; a bogus key now gets `Forbidden: Invalid API key`. **Fixed.**

**b. The settlement write was unchecked and targeted a column that does not exist.** First run: 0.10 USDC moved on-chain (tx `0x11dd9fd6…`, provider 2.80→2.90 verified independently), the caller was told `SETTLED`, and the row stayed `status='settling'` with `tx_hash=NULL`. Cause: the update wrote `facilitator_response`, which the **generated types claim exists but the live table does not have**, and its error was never checked. That is the exact silent-success failure the module was written to prevent, committed by the module itself. **Fixed** — verified columns only, error checked, and a new terminal status `SETTLED_UNRECORDED` reports "the transfer is real but our row does not say so" rather than collapsing into `SETTLED`. The idempotency guard held throughout: a retry against a `settling` row is refused, so no double-spend was ever possible.

**c. `POST /rfqs/:id/accept` never checked `offered_by`.** A buyer could award its own counter-offer — not an agreement, just the buyer setting the price unilaterally, which would return `agreed_price_usdc_raw` to meaning "whatever the buyer typed". **Fixed.**

**d. The applied schema diverged from the authoritative DDL.** Built from a truncated copy, it was missing six columns the RPC writes, and carried the **inert** form of the anti-collusion constraint (`was_lowest_price OR is_uncontested OR …` — an uncontested award is trivially "lowest", so it never fired on the single-bidder case, which is the shape of a wash trade). **Fixed** — split so an uncontested award must also carry a reason code and ≥24 characters of explanation.

**e. Three phantom-column bugs in one night.** `facilitator_response` (mine), `x402_settlements.amount_usdc_raw` (found by the verifier in `exchange-red-team.ts`), and `repid_score_events.new_repid` (mine, in a diagnostic query — the real column is `repid_after`). **`src/types/database.types.ts` is stale and is not a trustworthy schema oracle. Query `information_schema` instead.**

## 3. 🔴 PRODUCTION FINDING — a dead `DATABASE_URL` on two services

Two different values are deployed across the fleet:

| fingerprint | deployed on | liveness |
|---|---|---|
| `f01a57152f17` | all 25 AITrinitySymphony services | **LIVE** |
| `db7ee7009754` | **`repid-engine` and `proof-drain-worker`** | **DEAD — `password authentication failed`** |

Tested by opening a real connection to each. This is not a guess.

**Consequences, both previously mysterious:**
- `FeedbackLoopWorker` polls `repid_events` through `direct-pg`, so on production it cannot read events at all — **no ERC-8004 write has been possible since the value went stale.** Matches the 9-day gap exactly.
- `proof-drain-worker` cannot connect, which is why the **40,560-job proof queue never drains** despite the `unref()` fix landing.

It surfaced now only because that same fix made `direct-pg` report `FATAL CONFIG ERROR` loudly instead of dying silently.

**NOT FIXED, deliberately.** Railway env is Sean's call, and repointing `proof-drain-worker` at a working database would immediately mint ~40,000 proofs and ~400 attestations certifying internal HAL scoring churn — the exact outcome `STATE_OF_THE_SYSTEM` warns against. Correct order: land the producer-side churn filter in enforce mode (`PROOF_ENQUEUE_HAL_MODE=enforce`), **then** fix the URL.

## 4. What did NOT run

- **`zkp_audit` as a sellable service** — built, unwired. Adversarial review returned BROKEN and verification returned PARTIAL, with named defects open (non-atomic write breaking its own idempotency claim; a "contract-bound nonce" that binds nothing checkable; the handler registered in neither `agent.ts` nor `cascade-settlement-worker.ts`).
- **Anonymous red-team audit** — built, unwired. Verification REFUTED two of its claims, including a settlement leg that selects a nonexistent column.
- **A ZK proof of the delivered work** — `repid_proof_queue` has no `contract_id`. Nothing links a contract to a proof of what was delivered; today's proofs cover RepID score deltas only.

## 5. Reproduce

`scripts/e2e/negotiated-zkp-exchange.mjs` against a local engine on the production DB. It has no mock branch: any leg that cannot run for real halts and is reported, never faked.

---

## 6. Churn filter landed in enforce mode — 2026-07-31 23:4x PDT

Both halves set **service-level** on `repid-engine` AND `proof-drain-worker`, read back through each service to confirm the write took effect (service-level vars shadow shared ones):

| flag | side | before | after |
|---|---|---|---|
| `PROOF_ENQUEUE_HAL_MODE` | producer — stops NEW churn entering the queue | unset (→ `shadow`) | **`enforce`** |
| `PROOF_DRAIN_CHURN_MODE` | consumer — excludes EXISTING churn from the drain | unset (→ `off`) | **`enforce`** |

The env change triggered a redeploy of both services; both reached `SUCCESS`, and prod `/health` is green on `f6496b9` with `supabaseConnected=true`.

**Verified behaviorally, not just "the variable is set".** The guard's own `CHURN_AWARE_PENDING_BATCH_SQL` was run read-only against production with `$5=true`:

| | legacy (`off`) | **enforce** |
|---|---|---|
| `HAL_SCORE_EVENT` | 40,277 | **0** |
| `SERVICE_FULFILLED` | 258 | 258 |
| `SERVICE_SATISFIED` / `VALIDATION_FAILED` / `VALIDATOR_REWARD` / `PREDICTION_RESOLVE` | 13 | 13 |
| rows with a NULL `event_id` | 22 | 22 — reported, never silently swallowed |

**When the drain restarts it will prove 271 economic jobs instead of 40,548.**

Two honest caveats:
- The **producer** flag currently has nothing to bite on: zero churn has been enqueued in 48 hours (the only recent queue rows are the 10 economic events from this E2E). It is preventive, and cannot be behaviorally confirmed until HAL scoring traffic resumes.
- The residual cost documented in the guard is real: with the backlog 99.4% churn, an idle poll walks ~40.5k rows (~300 ms) each cycle. It disappears once the backlog is dispositioned, and it is the price of not minting 40k proofs.

**Step 1 of 2 is complete.** `DATABASE_URL` on those two services is still the dead `db7ee7009754` value (§3) and is now the only thing standing between here and a working proof drain — but it is a Sean call, and the churn guard had to land first.
