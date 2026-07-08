# RepID Engine Architecture (S-BUILD Phase 5)

## The Five-Layer Stack

### Layer 1: ERC-8004 Identity (WHO)
On-chain agent/human identity on Base Sepolia. ERC-8004 ValidationRegistry + agent cards.

### Layer 2: RepID Credentials (HOW MUCH TRUST)
- Formula (current): multiplicative R·W·C with babylonianSqrt(stake) + BUILDER_FLOOR (see authority-math.ts:60-71)
- Decay: 0.0015 per day
- Tiers: PROBATIONARY (0-99) → EARNING (100-499) → ESTABLISHED (500-1999) → AUTONOMOUS (2000-4999) → VETERAN (5000+)
- Earned floor trigger on peak_repid updates

### Layer 3: x402 Payments (EXECUTE)
RepID gates payment authorization. High RepID = lower friction / higher limits.

### Layer 4: ANFIS Routing (OPTIMAL)
- Virtue weights: Truth 0.40, Speed 0.30, Stewardship 0.30
- LASSO regularization + provider carousel (groq, cerebras, anthropic, openai, gemini, deepseek, etc.)
- Direct-pg + Supabase dual path for reliability

### Layer 5: HyperDAG Audit (IMMUTABLE)
- Hash-chain (SHA-256) on hal_production_events / hal_audit_chain
- Pythagorean Comma BFT veto threshold (gap < 0.05 && avg > 0.85)
- BFT consensus quorum derived from φ (61.8%)
- tool_call_log for delegation provenance

## Behavioral integrity — defended-deception layer (shadow-first)
`src/engine/behavioral-integrity.ts` is a **new, separate** integrity layer — NOT the
`src/layers/constitutional-audit.ts` stub (which remains a not-implemented Sprint-3 contract surface,
gated OFF by `CONSTITUTIONAL_AUDIT_ENABLED=false` and influencing no score).

- Detects **defended deception** by checking each interaction against a keccak256 **hash-chained
  interaction record** (reuses `hashkey-chain.ts` `evidenceHash` — anchorable on-chain, no new crypto).
- **Record-grounded classes** (denial-of-prior-output, fabricated citation/tool/benchmark, story-change)
  fire only on a provable mismatch against the chain — precision/recall ≈ 1.0 on the grounded eval set.
  **Heuristic classes** (doubt-attack, sycophancy, threshold-dancing) are advisory-only, weaker on
  paraphrase; overall deceptive recall ~0.73. Honest-agent false-positive rate = 0 (guards protect
  first citations, honest self-corrections, scoped denials).
- **Asymmetric penalty:** honest error stays cheap; a *confirmed grounded* detection is penalized
  several times heavier. The heavy penalty applies only on a confirmed grounded detection.
- **Mode gate `TRUST_DECEPTION_MODE` — default `shadow`:** in shadow mode it computes and records the
  would-be penalty in the audit row but is **truly inert** — `current_repid` is never mutated (no delta,
  no decay, no activity bump). `enforce` (off by default) applies it. Enforcement is never incidental.

## Provider resilience (HAL quorum)
`src/hal/fact-check.ts` + `src/providers/{openrouter,sambanova}.ts` — the cross-LLM HAL quorum counts
**distinct model families** (two hosts of one base model = one vote). OpenRouter and SambaNova are wired
as OpenAI-compatible providers (env-key only). The quorum **auto-backfills the next cheapest live
families** (gated by `HAL_QUORUM_AUTOBACKFILL`, default on), so a 429 burst on the primaries degrades
gracefully to a still-valid quorum rather than collapsing to the extractor. Family-disjointness is
enforced via `src/decisioning/disjointness.ts`.

## Data Flow
Prompt → ANFIS routes (with RepID context) → LLM → HAL 5-signal score → RepID delta apply (with guards; defended-deception penalty computed shadow-first, applied only in enforce mode) → hash-chain append → on-chain anchor (testnet)

## Key Files
- src/services/authority-math.ts (formula)
- src/scoring/pipeline.ts (HAL delta + direct apply)
- src/engine/behavioral-integrity.ts (defended-deception detectors + hash-chained record)
- src/engine/repid-update.ts (TRUST_DECEPTION_MODE shadow/enforce gate)
- src/hal/fact-check.ts (cross-LLM quorum + auto-backfill), src/decisioning/disjointness.ts
- src/routes/v1/observability-public.ts (public /agents/minted + /observability/onchain-stats)
- scripts/eval/canary-f1.ts (known-answer HAL F1), scripts/eval/model-leaderboard.ts (earned ratings)
- src/routes/* (public + internal)
- supabase/migrations/* (RLS, audit, triggers)
- scripts/verify-chain.ts (tamper detection)

## Evaluation harnesses
- **Canary F1** (`scripts/eval/canary-f1.ts` + `eval/canary/canary-corpus-v1.1.jsonl`) — re-runnable
  known-answer HAL-accuracy eval over the real cross-LLM quorum. Latest directional snapshot: F1 ≈ 0.95
  on a clean 47-claim oracle (N=47 — directional, not a universal benchmark). Report:
  `reports/2026-07-07/CANARY_HAL_F1_BASELINE.md`.
- **Earned model leaderboard** (`scripts/eval/model-leaderboard.ts`) — deterministic re-scoring of the
  verified canary verdicts into receipt-backed, coverage-gated, multi-axis provider ratings; UNRATED for
  providers with no verified votes. Distinct from the live `GET /api/v1/llm-trust` endpoint. Report:
  `reports/2026-07-08/EARNED_MODEL_LEADERBOARD.md`.

## MAESTRO Compliance
Covers multiple MAESTRO layers for agentic AI threat modeling via HAL + RepID + immutable audit.

See also: SCHEMA_TRUTH_MAP.md, S-SDK1 specs, S-HARMONIA-1.
