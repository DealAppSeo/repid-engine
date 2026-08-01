# E2E ground truth — verified 2026-07-31 19:2x–20:0x PDT
**Every line here is [V] — queried live, not recalled.** Build agents: do not re-derive these; do challenge them if something contradicts.

## Deployed engine
`https://repid-engine-production.up.railway.app/health` → `deployed_commit=f6496b9e8cc5ca099141a29612ac6959b6e70460` (= current `origin/main` tip), `status=ok`, **`supabaseConnected=true`**, `deployerConfigured=true`. Railway project **`repid-engine`** (NOT AITrinitySymphony), 3 services: `repid-engine`, `receipt-indexer`, `proof-drain-worker`.

Validation queue: 16 `hitl_pending` (all >24h), `stuck=0`, `pending=0`. Those are awaiting a human, not a broken worker.

## On-chain preconditions (Base Sepolia, chainId 84532)
| Purpose | Address | ETH | USDC |
|---|---|---|---|
| `BASE_SEPOLIA_PRIVATE_KEY` = `TRINITY_DEPLOYER_PRIVATE_KEY` | `0xdf6b8215D193b11B4903d223729c3CF7A6de271d` | 0.05492 | 89.39 |
| `DEPLOYER_PRIVATE_KEY` | `0xf6eE1768868c3266868edcA78bC41C50309cb22A` | 0.03265 | 51.90 |
| `ERC8004_WRITER_V2_KEY` | `0xb24268884472E7613aA58D38C8813f7Af1667382` | 0.03229 | — |

USDC (Base Sepolia): `0x036cbd53842c5426634e7929541ec2318f3dcf7e`. ERC-8004 IdentityRegistry `0x8004A818BFB912233c491871b3d84c89A494BD9e`.

**Gas and USDC are sufficient for the E2E. Nothing needs funding.** `ERC8004_REPUTATION_WRITER_KEY` / `ERC8004_OPERATOR_KEY` / `HYPERDAG_ATTESTOR_PRIVATE_KEY` are **absent from `.env.master`** — they live only in Railway env, so any leg needing them must run **through the deployed engine**, not from a local script.

## Live schema — use these column names, do not guess
`agent_services`: `id, provider_agent_id, service_type, service_name, description, base_price_usdc_raw, min_repid_to_purchase, capability_metadata, active, total_fulfilled, total_satisfied, avg_satisfaction, created_at, updated_at, deactivated_at`

`service_contracts`: `id, service_id, buyer_agent_id, provider_agent_id, agreed_price_usdc_raw, payload, result, status, x402_payment_id, buyer_satisfaction_score, dispute_panel_validation_queue_id, dispute_verdict, created_at, escrowed_at, fulfilled_at, satisfied_at, settled_at, disputed_at, resolved_at, expires_at, metadata`

**There is NO bid / offer / quote / negotiation table.** `agreed_price_usdc_raw` is a misnomer today — nothing is agreed, the base price is copied at creation.

## Live data
- `service_contracts`: **176 rows** — `fulfilled 146 · resolved 24 · disputed 3 · cancelled 2 · **settled 1**`. One settled contract in the system's history.
- `agent_services` active: `verification` (100000 raw, 12 providers), `cross_validation` (500000, 12 providers), `reputation_audit` (500000, 1), `fact_check` (150000, 1), `anfis_routing` (50000, 1), `decentralized_storage` (200000, 1), plus one `verification` at 50000 with `min_repid_to_purchase=0`.
  **Every provider of a given type lists the identical price.** No price differentiation exists to negotiate over. There is **no `zkp_audit` or `security_audit` service type active.**
- `erc8004_reputation_writes`: **72 rows**, newest `2026-07-23T04:36:23Z` tx `0x2b4dd7bd09cbff4b77244ad30c2b72cc94971b03c193980ce457d24961c33e9d`.
- `x402_settlements`: newest `2026-07-23T04:33:36Z` tx `0xeea707f39a25a52066ba208d1a24d23d525cb15f8f3a6697e6acb78b26411148`, **`is_simulated=false`** — real settlement works, it has just been idle 8 days.
- `repid_proof_queue`: **40,560 pending**. The churn filter EXISTS on main (`src/services/proof-enqueue-filter.ts`, `src/scoring/pipeline.ts:442`) in **shadow mode**; `PROOF_ENQUEUE_HAL_MODE=enforce` gates it. ~99.3% of the backlog is `HAL_SCORE_EVENT` churn. **A paid contract is an economic event and must NOT be filtered** — verify your enqueue path survives the filter.

## Auth
`REPID_API_KEYS` is present in `.env.master` (format `key:tier,key:tier`). `GET /api/v1/marketplace/services` returns `Unauthorized: API key required` without it. `GET /api/v1/repid/*` and `GET /api/v1/erc8004/validate/*` bypass auth.

## ⚠ CORRECTION — added after a full lifecycle map (2026-07-31 20:1x)

**Payment happens at ESCROW, not after verified delivery.** `POST /api/v1/contracts/:id/escrow` (`src/routes/v1/contracts.ts:124`) calls `verifyPayment` (`:330`) then `settlePayment` (`:350`) **up front**, and even back-dates `settled_at` at `:428`. There is no post-fulfillment settlement step for contracts. The requested sequence — *work done → verified → THEN tokens move* — **does not exist today and must be built.** This is the keystone gap.

Other corrections to assumptions:
- Real lifecycle is DB-trigger-enforced, not app-enforced: `pending → escrowed → fulfilled → satisfied → settled`, plus `disputed → resolved`, `expired`, `cancelled`. Trigger `trg_service_contracts_status_transition`, `supabase/migrations/20260516000002_phase2_9_service_contracts.sql:54-91`. **There is no `claimed` status** — claiming is a metadata stamp while status stays `escrowed`.
- `settled` on a contract is a *satisfaction* state, not a payment state. The money already moved at escrow.
- Simulation switch is `X402_REAL_RPC`. When unset, `contracts.ts:366` writes the **base64 payment header into `x402_settlements.tx_hash`** as a fake hash with `is_simulated: true`.
- **Two x402 implementations.** The contract path uses the remote facilitator (`src/services/x402-facilitator.ts`, `buildV2Envelope` at `:88-121`) — the engine never broadcasts. `src/services/x402-real-settler.ts` broadcasts for real but is called **only** from a test and a script; it is not on the contract path.
- ERC-8004 writes fire from `FeedbackLoopWorker` (`src/workers/feedback-loop-worker.ts:46`, started unconditionally at `src/index.ts:804`) on `repid_events.event_type='service_fulfilled_settled'`, and only when `x402_payment_id` is non-null. Gated on `current_repid >= 1000` and a present `erc8004_token_id`.
- **Plonky3 proving is NOT in this repo.** `proof-drain-service.ts:509` POSTs to the external `zkp-postcard` Railway service. In-repo `src/zkp/plonky3-real.ts` falls back to an **HMAC-SHA256 stub** when no prover URL is set. Any "real proof" claim must name which of these produced it.
- `repid_proof_queue` has **no `contract_id`**. Nothing links a contract to a proof of the delivered *work* — only to a proof of a RepID score delta.
- Registered handlers (`src/routes/v1/agent.ts:50-57`): `verification`, `cross_validation`, `anfis_routing`, `reputation_audit`, `decentralized_storage`, `security_audit`. **No `zkp_audit`.**
- **BUG:** `security_audit` is registered in `agent.ts` but missing from `cascade-settlement-worker.ts:50-56`, so those contracts never drain server-side.
- **BUG:** `POST /:id/satisfy` (`:515-532`) has no status precondition and no atomic guard, unlike `/fulfill`. It relies entirely on the DB trigger.
- `contracts.ts:293` falls back to `payTo: 0x0000…0000` when a provider has no `wallet_address`.
- `X402_BUYER_PRIVATE_KEY` is **absent** from `.env.master`. Reuse `BASE_SEPOLIA_PRIVATE_KEY` (0xdf6b…271d, 89.39 USDC) at runtime — do not mint a new wallet.

## Hard constraints
1. **No mocks, no simulation.** `is_simulated=false` or it does not count. A leg that cannot run for real must be reported as not-run, never faked.
2. **No self-validation.** Auditor ≠ either counterparty; verifier ≠ producer. This is enforced elsewhere in the codebase — match the existing mechanism, don't invent a parallel one.
3. **Schema-first.** New tables are additive net-new objects only. Never alter `service_contracts` or `agent_services` in place. All prod DDL gets logged.
4. **Sprint-3 stubs stay.** Do not "fix" a passing stub into fake behaviour.
5. `repid_agents.tier` is trigger-derived (`trg_sync_tier`). Writing it is theatre; the DB wins.
6. Tier bands: PROBATIONARY 0–499 · EARNING 500–999 · ESTABLISHED 1000–4999 · AUTONOMOUS 5000–7999 · VETERAN 8000–10000. Score clamp [10, 10000].
