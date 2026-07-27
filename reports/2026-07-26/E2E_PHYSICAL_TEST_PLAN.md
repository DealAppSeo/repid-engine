# E2E Physical Test Plan — human → agent → A2A → x402 → ERC-8004
**Created:** 2026-07-26 · **Goal:** a real human signs up, binds to an agent (ZKP), stakes testnet USDC, tasks the agent on trustmarket.dev; two agents transact via x402; both RepIDs move on-chain via ERC-8004 — and we can SEE + PROVE every step. This is the thesis demo AND the reduction-to-practice for the trust-harness patents.
**Status: ~80% built** (backend exists; gaps = frontend face + task handlers + test-env flags + receipt view). Verify-first grounding: full-account.ts, human_sbt_mints.commitment_hash, /stake/deposit, faucet.ts, agent_services.min_repid_to_purchase, X402/FeedbackLoopWorker all present in code 2026-07-26.

## The loop (stage · EXISTS[V]/GAP · what to prove)
| # | Stage | State | Prove |
|---|---|---|---|
| 1 | Human signup → account | ✅ full-account.ts | account created |
| 2 | **Owner-binding (ZKP)** — human_sbt_mint commitment_hash binds human→agent | ✅ tables/auth exist | binding verifies; nullifier scoped; un-bound agent can't be tasked |
| 3 | Faucet → human funds testnet USDC | ✅ faucet.ts | balance ≥ stake threshold |
| 4 | **Stake deposit** (real, testnet) | ✅ flag-gated (REAL_STAKING_ENABLED + STAKE_ESCROW_ADDRESS) | is_simulated=FALSE; on-chain deposit tx verified |
| 5 | **Stake gates capability** | ✅ min_repid_to_purchase | unstaked agent CANNOT buy the high-stakes service; staked CAN |
| 6 | Human tasks agent → buyer agent creates A2A contract | ✅ marketplace + cascade | contract pending→escrowed |
| 7 | Provider agent performs the service | ⚠ need 2-3 real service handlers | deliverable produced |
| 8 | **HAL scores the deliverable** (grounded; → proof-carrying inclusion later) | ✅ HAL; proof-carrying = P2 | deliverable graded; ungrounded → abstain/veto |
| 9 | **Peer-verify (independent, no self-validation)** | ✅ #185/#186 | verifier ≠ producer; self-validation rejected + penalized |
| 10 | **x402 settlement** (real testnet USDC) | ✅ proven 07-22 | is_simulated=FALSE; on-chain settle tx on BaseScan |
| 11 | **RepID deltas** (both parties) | ✅ scoring pipeline | provider ↑ for delivery, buyer satisfaction feeds it; correct amounts |
| 12 | **ERC-8004 on-chain reputation write** | ✅ FeedbackLoopWorker | tx verified on BaseScan; both agents moved |
| 13 | **Human sees receipts** (x402 tx + ERC-8004 tx + RepID Δ + verification chain) | ⚠ GAP: receipt view | user can audit the whole chain |

## MUST ALSO PROVE (negative / enforcement path — this is what makes it peer-review + patent grade)
- **Buyer protection:** bad deliverable → HAL veto → payment HELD/refunded from escrow → provider RepID penalty. (Prove the buyer isn't scammed.)
- **Asymmetric penalty:** a lie/cover-up/willful-bad drops RepID FAR more than an honest miss. (Prove the asymmetry — the core moral primitive.)
- **No-self-validation bites:** an agent verifying its own work → rejected + RepID hit.
- **Owner-binding gates:** an un-bound / un-owned agent cannot be tasked or paid.
- **Idempotency/breakers:** retries don't double-spend USDC or double-count RepID; birth-rate breaker holds.
- **Full auditability:** the entire loop is reconstructable from on-chain (x402 + ERC-8004 tx) + committed roots (proof-carrying retrieval + EAS anchor). This is the moat.

## Task menu — A2A trust-economy use cases users SEE value in
The value prop: your agent can safely HIRE a specialist agent it doesn't trust-by-default, because the harness (RepID + HAL + x402 escrow + ERC-8004 + ZKP) makes it pay-only-for-verified-quality with an on-chain receipt — something a plain API call can't do.
1. **Verified fact-check / claim-check** (Sean) — verdict + cited evidence (proof-carrying) + HAL grounding + independent peer-verify. *Shows verified truth vs an LLM guess. Best tie to what we're building.*
2. **Counterparty due-diligence** ("should I trust agent/vendor X?") — a RepID + on-chain-history reputation report. *The trust layer's NATIVE product: reputation-as-a-commodity. Most "aha, THIS is what a trust layer is for."*
3. **Security/safety audit** (Sean) — auditor agent finds risks; a 2nd agent peer-verifies. *Shows independent verification + the punish path (a lazy auditor that misses a bug loses RepID).*
4. (also strong) **Cheapest/fastest provider routing** (Sean, ANFIS), **provenance-backed research/summary** (proof-carrying), **escrowed pay-only-if-it-passes micro-task**, **two-sided debate/second-opinion** (AIDebate tie-in).
→ **Demo trio recommendation: #1 fact-check + #2 due-diligence + #3 audit** (covers truth, reputation-as-product, and enforcement).

## Build path to a demoable E2E (dependency-ordered)
1. **Service handlers** for the demo trio (fact-check / due-diligence / audit) as A2A `service_type`s with `min_repid_to_purchase`. [GA/CC]
2. **Frontend face** on trustmarket.dev / trusttrader.dev: signup → mint SBT (bind) → faucet → stake → pick task → live loop. Backend endpoints already exist. [GA/v0]
3. **Receipt view**: x402 tx + ERC-8004 tx + RepID deltas + the verification chain, links to BaseScan. [GA/CC]
4. **Test-env flags (Sean-gated):** REAL_STAKING_ENABLED, STAKE_ESCROW_ADDRESS, X402_ENFORCEMENT_ENABLED, X402_REAL_RPC — on in a staging/test env first. + a funded testnet buyer wallet.
5. **Negative-path harness:** scripted bad-deliverable + self-validation + un-bound-agent cases proving the enforcement matrix above.
6. **Human RepID confirm:** verify a human sees an earned RepID (vs SBT qualification_tier) — small add if missing.

## Related asks (2026-07-26) noted for the loop
- **Mobile control surface:** controller-pwa (DealAppSeo/controller-pwa, the HITL PWA — EXISTS) + Telegram @AITrinityBot (wired). Integration ideas to explore: Claude Mobile (this loop via app), Grok mobile (XC co-sign), Railway + GitHub mobile (deploy/merge from phone). → design note later.
- **Cross-agent merge co-sign:** before auto-merge/ping, a 2nd agent (XC/GA) independently reviews the PR (no-self-validation applied to merges). Gated on headless XC/GA auth.
- **Periodic updates:** loop pushes a periodic Telegram digest (built PRs, merge-ready queue, swarm activity, blockers).
