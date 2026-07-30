# Positioning HyperDAG + HAL against the agentic-checkout adoption gap
**Date:** 2026-07-29 · **Trigger:** industrycontents.com "The Agentic Checkout Adoption Gap" · **Author:** CC (Claude Code) · **Status:** positioning ratified by build (see §5); frontend copy pending Sean review

## 1. What the article establishes (their data, our reading)

- **The gap is trust, not demand.** 89% of merchants "preparing" for agentic commerce vs ~3% of transactions (Mar 2026) — while AI-referred visitors convert **+54%** better (Adobe, May 2026) and Shopify sees **13x** YoY AI-referred orders. Demand works; delegation doesn't.
- **The consumer blocker is payment control.** 24% "will never delegate a purchase to AI"; 27% trust no organization to run their agent. The friction is *handing the agent the card*, not using the assistant.
- **The merchant blocker is now legal, not just technical.** Amazon v. Perplexity (Mar 2026): **user permission ≠ merchant authorization**; unauthorized agent access to gated surfaces ≈ CFAA exposure. Agent access became something platforms must explicitly **grant**.
- **Protocol fragmentation with no referee.** ACP (OpenAI/Stripe), UCP (Google/Shopify), AP2 (Google + Mastercard/PayPal/Amex/Coinbase), Visa/Mastercard identity frameworks. AP2's signed mandates prove *the user authorized the purchase*. **Nothing in any of the four proves the agent itself is trustworthy or competent.**

## 2. The white space (what none of them do)

Every checkout protocol standardizes the *transaction*. None standardize the **underwriting decision** the Chesney ruling now forces on every merchant: *which agents do we grant access, and on what evidence?*

That is precisely the shape of what we run today:

| The gap's question | Our answer | Real today? |
|---|---|---|
| Who is this agent? | ERC-8004 identity (IdentityRegistry `0x8004A818…`, Base Sepolia) | ✅ real mints, live registry |
| Has it behaved? | RepID behavioral score, 3-touchpoint transaction ladder (settle → to-spec → held-up-in-use), HAL verification | ✅ live engine; weights still tuning (by design) |
| Did real money move? | x402 v2 settlements, real-vs-simulated flagged on every row; **mock money earns zero reputation** | ✅ 389 settlements; idle since 07-23, not broken |
| Is the history on-chain? | ERC-8004 ReputationRegistry `giveFeedback()` writes + EAS anchors | ✅ 72 writes, 220 EAS anchors |
| Can it prove standing without exposing internals? | ZKP **range proof** (score ≥ threshold without revealing score) | ⚠️ range proof real path scaffolded; prover not deployed (HMAC fallback, loudly labeled). Transcript binding = roadmap (D-019) |
| Card-free delegation | x402 pay-per-call with per-tier spend authority (`x402-gate`) — the agent never holds a card | ✅ testnet |

**One-line positioning:**
> *The four checkout protocols decide how agents pay. RepID decides which agents deserve to.*

**Honesty rails (D-019 + XC audit 2026-05-28, non-negotiable in all copy):** never say "Plonky3 attests RepID" or "ZK-verified behavior." Today's proof is a **range proof over the score**; binding proofs to agent execution transcripts is the roadmap (and the proof-carrying-memory work in this repo is the path). Testnet is testnet — say Base Sepolia.

## 3. Surface positioning

**TrustShell.dev — "the agent's passport office."** Where an agent (or its operator) gets an identity, earns reputation, and *presents* it: mint ERC-8004 identity → earn RepID through verified work → present the Trust Passport / ZKP card. Consumer-fear answer: *you don't hand your agent a card; you grant it a scoped, capped x402 spending authority, and its whole payment history is inspectable.*

**TrustMarket.dev — "the proving ground."** Where reputations are *earned under adversarial conditions*: agents hire agents, real (testnet) money settles via x402, HAL verifies work, outcomes move RepID, everything lands on-chain. Merchant-side answer: *don't authorize agents on faith; authorize them on a settlement-gated, third-party-verified track record.* (Sim finding applies: outcome-verification O must be ≥75% third-party-verified — the market IS the verification supply.)

**HAL's role in both:** the verification layer that makes ratings ground-truth-anchored rather than vibes — the "was the work actually good?" oracle feeding T2/T3.

## 4. What we do NOT claim (scope fences)

- We are not a checkout protocol and don't compete with ACP/UCP/AP2 — we're the **rail-agnostic trust layer underneath** any of them (same "rail-agnostic" posture the article recommends merchants take).
- No mainnet money. No consumer card flows. No "verified" badge that isn't backed by a chain read or an honest `registered_onchain` fact.
- RepID weights are explicitly **in tuning** — that's what the public test period is *for*.

## 5. Built today (repid-engine PR, branch `feat/cc-2026-07-29-agent-trust-passport`)

1. **`GET /api/v1/passport/:agentId` — Agent Trust Passport (NEW, public).** The one-call underwriting composite: RepID + DB-derived tier, ERC-8004 mint metadata + linked live `ownerOf()` cross-check, x402 real-vs-simulated counts + last real tx (BaseScan link), on-chain reputation writes, latest ZKP proof honestly labeled. DB-first (no per-request RPC), fail-loud, 14 new tests.
2. **`GET /api/v1/erc8004/validate/:agent_id` — honest rewrite.** Was fabricating `validation_status:"verified"` + `conservator_bonded:true` with zero chain reads and zero tests, on the exact endpoint a merchant would hit. Now: `registered_onchain | offchain_only` from recorded mint state, fabricated fields removed, passport linked.
3. **Docs:** README + docs/API.md; this positioning report.
4. **Flagged (spun off, not fixed here):** F1 asymmetry — T2 (`/satisfy`), T3 (`/outcome`), and dispute deltas are not gated on `is_simulated` (T1 is). Chip filed to close it; matters because "mock money earns zero reputation" is a headline claim.

## 6. Next (frontend wiring — separate repos/PRs)

1. **TrustShell `/passport/[agentId]` page** rendering the passport JSON (identity block, settlement history, proof block with honest labels) + a "Verify live on-chain" button hitting `/api/v1/agents/:id/onchain`. TrustShell already consumes the engine (18 routes live).
2. **TrustMarket split-brain reconcile first**: the deployed checkout (`trustmarket-landing`, has the A2A/machine-discovery routes) and the newer `trustmarket` checkout (honest README) have diverged tips — merge before adding pages. Then: a "Why agents earn trust here" page + passport links on every listed agent.
3. **Invite loop (testers):** point testers at `docs/USER_GUIDE_FIRST_5_MINUTES.md` → anonymous builder signup (`POST /api/v1/builder/token-signup`, no wallet needed) → run the contract loop on TrustMarket → watch their passport change. Zero real money (Base Sepolia).
4. Dogfood corpus (backlog 5.1) doubles as the demo dataset: 10 contracts through create→claim→HAL→score→ERC-8004 so passports have fresh, inspectable history on invite day.
