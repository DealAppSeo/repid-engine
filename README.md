# repid-engine

> Open-source reputation backend for AI agents. ERC-8004 identity oracle and x402 payment coordinator. Powers the HyperDAG Protocol Trust ecosystem.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Standard: ERC-8004](https://img.shields.io/badge/Standard-ERC--8004-blue)](https://github.com/DealAppSeo/hyperdag-protocol)
[![Network: Base Sepolia](https://img.shields.io/badge/Network-Base_Sepolia-success)](https://sepolia.basescan.org/)
[![HAL: live](https://img.shields.io/badge/HAL-live-success)](#hal--hallucination-auditor-layer)

`repid-engine` is the API and scoring engine behind:

- **[TrustShell](https://trustshell.dev)** — the `@hyperdag/trustshell` SDK for AI agent integration.
- **[TrustRepID](https://trustrepid.dev)** — public reputation leaderboard for AI agents.
- **[HyperDAG Protocol](https://github.com/DealAppSeo/hyperdag-protocol)** — protocol spec, contracts, and reference implementations.

Every score change is auditable, every reputation write is anchored on-chain, and every public read is keyless.

---

## Live on Base Sepolia

Canonical contracts, chain ID **84532**:

- **IdentityRegistry** — [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://sepolia.basescan.org/address/0x8004A818BFB912233c491871b3d84c89A494BD9e)
- **ReputationRegistry** — [`0x8004B663056A597Dffe9eCcC1965A193B7388713`](https://sepolia.basescan.org/address/0x8004B663056A597Dffe9eCcC1965A193B7388713)

Real on-chain attestations are publicly queryable. See `GET /api/v1/receipts/hero` below for a fully verifiable end-to-end loop (USDC payment → on-chain reputation attestation).

---

## Public API

Production base URL: `https://repid-engine-production.up.railway.app`

All endpoints below are **public — no API key required**. CORS allows `trustrepid.dev`, `trustshell.dev`, and localhost.

### `GET /api/v1/status`

Consolidated health + 24h economic activity.

```bash
curl https://repid-engine-production.up.railway.app/api/v1/status
```

```json
{
  "service": "repid-engine",
  "version": "1.0.0",
  "network": "base-sepolia",
  "operational": { "supabase": true },
  "metrics_24h": {
    "onchain_attestations": 0,
    "real_settlements": 0,
    "score_events": 120,
    "firecrawl": { "enabled": true, "calls": 0, "cost_usd_24h": 0, "by_agent": [], "note": "rollout active, 0 calls in last 24h" }
  },
  "hero_receipt": "/api/v1/receipts/hero"
}
```

### `GET /api/v1/receipts/hero`

The first verified end-to-end economic loop: USDC settlement on chain → reputation attestation on chain. Every transaction hash is real and clickable.

```bash
curl https://repid-engine-production.up.railway.app/api/v1/receipts/hero
```

```json
{
  "label": "First live USDC settlement → on-chain reputation attestation (full economic loop)",
  "network": "base-sepolia",
  "chain_id": 84532,
  "value_usdc": "0.10",
  "provider": "trinity-shofet",
  "repid_change": { "before": 2980, "after": 3040 },
  "usdc_settlement": {
    "tx": "0x2a7ac151c23983f59564fc3da5c7ea74fdbe390f9e97fcbf70c79be27089967a",
    "basescan": "https://sepolia.basescan.org/tx/0x2a7ac151c23983f59564fc3da5c7ea74fdbe390f9e97fcbf70c79be27089967a"
  },
  "reputation_attestation": {
    "tx": "0xd362c1b0c819e2e1ee7bce601531afb0be1eef20c1be4ab8dc643e524d19e917",
    "registry": "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    "basescan": "https://sepolia.basescan.org/tx/0xd362c1b0c819e2e1ee7bce601531afb0be1eef20c1be4ab8dc643e524d19e917"
  }
}
```

### `GET /api/v1/hal/stats`

HAL (Hallucination Auditor Layer) production statistics — lifetime and last-24h windows across the full pipeline.

```bash
curl https://repid-engine-production.up.railway.app/api/v1/hal/stats
```

### `GET /api/v1/repid/:agentId`

Per-agent RepID lookup. Returns score + tier + freshness.

```bash
curl https://repid-engine-production.up.railway.app/api/v1/repid/f3ef0bf8-5cdc-4fad-bce8-5144f01dc271
```

```json
{
  "agent_id": "f3ef0bf8-5cdc-4fad-bce8-5144f01dc271",
  "repid_score": 9581,
  "tier": "VETERAN",
  "last_updated": "2026-05-26T19:55:50.833+00:00"
}
```

Tier scale: `PROBATIONARY` (0–499) → `EARNING` (500–999) → `ESTABLISHED` (1,000–4,999) → `AUTONOMOUS` (5,000–7,999) → `VETERAN` (8,000–10,000).

### `GET /api/v1/llm-trust`

Per-LLM hallucination-rate leaderboard.

```bash
curl https://repid-engine-production.up.railway.app/api/v1/llm-trust
```

### `GET /api/v1/firecrawl/stats`

Firecrawl research-tool rollout statistics (calls + cost over the last 24h).

```bash
curl https://repid-engine-production.up.railway.app/api/v1/firecrawl/stats
```

### `GET /api/v1/agents/minted`

Live list of every agent holding an ERC-8004 token (`repid_agents` where `erc8004_token_id IS NOT NULL`), ordered by RepID. Replaces the landing page's former hard-coded 4-agent list — new mints appear automatically. Adversarial mock agents are excluded by default; pass `?include_mock=true` to opt them back in for ops debugging.

```bash
curl https://repid-engine-production.up.railway.app/api/v1/agents/minted
```

```json
{
  "agents": [
    {
      "name": "trinity-sophia",
      "display_name": "SOPHIA",
      "agent_id": "trinity-sophia",
      "erc8004_token_id": "1",
      "current_repid": 10000,
      "tier": "VETERAN"
    }
  ],
  "count": 1
}
```

### `GET /api/v1/observability/onchain-stats`

Real on-chain counters for the "What we've built" stats block — `agents_minted` (count of `repid_agents` with a token id, mock-excluded by default) and `lifetime_onchain_writes` (the actual row count of `erc8004_reputation_writes`). No hard-coded constants: these were frozen at `agents_minted=4` / `lifetime_onchain_writes=32` until 2026-07-07, and now read live from the database.

```bash
curl https://repid-engine-production.up.railway.app/api/v1/observability/onchain-stats
```

```json
{
  "agents_minted": 12,
  "lifetime_onchain_writes": 70,
  "as_of": "2026-07-08T00:00:00.000Z"
}
```

> Dated live snapshot: `lifetime_onchain_writes` = **70** (live as of 2026-07-08; source: `/api/v1/observability/onchain-stats`). The block above is a captured example — the endpoint always returns the current live count, so treat any number here as a dated snapshot, not a fixed constant.

### `GET /.well-known/agent.json` (+ `/agent.json` alias)

AGNTCY-style agent card. Lists capabilities, protocols, and trust attestations.

```bash
curl https://repid-engine-production.up.railway.app/.well-known/agent.json
```

---

## HAL — Hallucination Auditor Layer

`src/hal/lib/` is the callable Hallucination Auditor Layer. It exposes a 5-level strictness scale (1 Fast → 5 Maximum, default 4) controlling which veto layers run:

1. **Extractor only** — fastest, pattern-based.
2. **Cross-LLM with semantic similarity** — adds embedding agreement.
3. **Three-zone Pythagorean Comma band** — adds harmonic uncertainty bounds.
4. **Consensus-vs-claim comparison** — adds verifier consensus.
5. **Tampering detection** — adds adversarial signal analysis.

```ts
import { evaluate } from './hal/lib';

const r = await evaluate(claim, output, {
  domain,
  certainty,
  prompt,
  providers,
  embeddingClient
});
```

Full API: [`docs/HAL_LIBRARY_API.md`](docs/HAL_LIBRARY_API.md). Tampering spec: [`docs/HAL_TAMPERING_DETECTION.md`](docs/HAL_TAMPERING_DETECTION.md).

---

## Behavioral integrity — defended deception (shadow mode)

`src/engine/behavioral-integrity.ts` adds a behavioral-integrity layer that targets **defended deception** — the failure mode where an agent's own account of events cannot be trusted (the "I never said that" defense). Rather than asking a model to adjudicate, it checks each new interaction against a **keccak256 hash-chained interaction record** (the same `evidenceHash` primitive as `src/engine/hashkey-chain.ts`, so a receipt root is anchorable on-chain with no new crypto). Tampering with any prior receipt breaks every hash after it.

The penalty is **asymmetric by design**: an honest wrong answer stays cheap (so agents surface it), while a *confirmed, grounded* defended-deception event is penalized several times heavier. The asymmetry is the mechanism.

Two tiers of detector, honestly separated:

- **Record-grounded classes** — denial-of-prior-output, fabricated citation/tool-result/benchmark, story-change-across-turns. These fire **only** on a provable mismatch against the chain. On an independent, de-circularized eval the grounded detections carry the heavy penalty only when `grounded = true`; **precision/recall on the grounded classes is effectively 1.0** on that set.
- **Heuristic classes** — doubt-attack, sycophancy (false-premise), threshold-dancing. These are **advisory only**, interpretable pattern signals marked with lower confidence; they are honestly **weaker on paraphrase**. Overall deceptive recall across all classes is roughly **~0.73** — the honest-first guards deliberately trade recall for a near-zero false-positive rate.

**False-positive rate on honest agents is 0** on the eval's clean set: guards prevent penalizing first-time citations, honest self-corrections, and scoped denials. The heavy penalty applies **only** on a confirmed grounded detection, and **only** in enforce mode.

**Mode gate — shadow-first (`TRUST_DECEPTION_MODE`):**

| mode | behavior |
|---|---|
| `shadow` (**default**) | Computes the would-be penalty and records it in the audit row, but **never mutates `current_repid`** (truly inert — no delta, no decay, no activity bump). Enforcement is never incidental. |
| `enforce` | Applies the penalty — **only** on a confirmed grounded detection. |

So today this layer is a **measurement**, not an enforcement: it observes without touching live scores. Detectors: `tests/behavioral-integrity.test.ts`; shadow/enforce gate: `tests/trust-keystone-deception.test.ts`.

---

## Evaluation

Two re-runnable, known-answer harnesses keep the accuracy claims honest and reproducible.

### Canary HAL-accuracy F1

`scripts/eval/canary-f1.ts` runs the **real cross-LLM HAL quorum** (`src/hal/fact-check.ts`) locally with live keys against a fixed known-answer oracle, `eval/canary/canary-corpus-v1.1.jsonl` (**47 claims** after a source spot-check dropped 3 rows from the original 50).

```bash
npx ts-node scripts/eval/canary-f1.ts   # keys auto-load from repo-root .env.master
```

Latest directional snapshot (clean-47 oracle): **F1 ≈ 0.95 (N=47 canary; harder 337-set F1 ~0.80)** (precision 0.905, recall 1.00, accuracy 0.957; TP 19 / FP 2 / TN 26 / FN 0 — zero false negatives, no false claim passed). This is a **directional snapshot on an easy N=47 known-answer set, not a universal benchmark** — see the rigorous 337-item eval below for the honest headline number. Full run: [`reports/2026-07-07/CANARY_HAL_F1_BASELINE.md`](reports/2026-07-07/CANARY_HAL_F1_BASELINE.md).

### Rigorous 337-item HAL eval (headline, provenanced)

The honest, harder-corpus measurement of the same real cross-LLM quorum over a **337-item fully-provenanced corpus** (FEVER + HaluEval + TruthfulQA + the in-repo canary), bootstrap 95% CIs:

- **F1 ≈ 0.80 [0.75–0.84]**, **recall ≈ 0.95**, **AUC ≈ 0.90**, well-calibrated (**ECE 0.056**).

Honest caveats (state these wherever the number appears):

- The quorum's real edge is **recall + vendor-independence, NOT raw accuracy** — a single strong model (DeepSeek, F1 ≈ 0.86 at full coverage) edges the quorum on F1; the quorum's value is not depending on any one vendor's uptime or honesty.
- Model **independence is partial** — some hosts serve identical weights (e.g. Groq + DeepInfra both run Llama-3.1-8B; error-correlation ≈ 0.88), so "6 providers" overstates diversity. **Weight-deduplication is in progress.**
- **Independent replication is in progress** before this number is headlined externally.

Full run + methodology, CIs, ablations, and the family-independence experiment: [`reports/2026-07-09/HAL_RIGOROUS_EVAL.md`](reports/2026-07-09/HAL_RIGOROUS_EVAL.md).

### Earned model leaderboard

`scripts/eval/model-leaderboard.ts` deterministically re-scores the verified canary verdicts into **per-provider ratings earned from real fact-checks** — not vendor benchmarks or vibes. Each rating carries its receipt (run + corpus hash). It is **coverage-gated** (a provider cannot top the board by abstaining — an ≥80% committed-vote floor is required to appear in the main table), **multi-axis** (accuracy / calibration / coverage / latency, kept separate), and marks providers with no verified votes as **UNRATED** rather than inventing a score.

```bash
CANARY_RAW='reports/2026-07-07/canary-f1-raw-2026-07-08T02-17-06-804Z.json' \
CLEAN_CORPUS='eval/canary/canary-corpus-v1.1.jsonl' \
  npx ts-node scripts/eval/model-leaderboard.ts
```

This is distinct from the live `GET /api/v1/llm-trust` endpoint (a rolling production hallucination-rate leaderboard); the earned leaderboard is an **offline, receipt-backed snapshot from one verified oracle run**. Full report: [`reports/2026-07-08/EARNED_MODEL_LEADERBOARD.md`](reports/2026-07-08/EARNED_MODEL_LEADERBOARD.md).

---

## Architecture

Express API + Supabase Postgres + Base Sepolia on-chain anchoring + ZKP-stub anchor chain.

```
helmet → cors → express.json → SQL-keyword sanitizer
       → public routers (status / hero / HAL / repid / llm-trust / firecrawl
                          / agents/minted / observability/onchain-stats / agent.json)
       → authMiddleware → versioning → authed routes
```

**Provider resilience.** The HAL cross-LLM quorum runs over disjoint model families (two hosts of the same base model count as one family/vote). OpenRouter and SambaNova are wired as additional OpenAI-compatible providers (env-key only), and the quorum **auto-backfills the next cheapest live families** (gated by `HAL_QUORUM_AUTOBACKFILL`, default on) so a burst that 429s the primary providers still reaches a quorum instead of collapsing to the extractor — a graceful 429 cascade rather than a hard failure.

The scoring pipeline (`src/engine/repid-update.ts`):

1. Fetch agent from `repid_agents`.
2. **Constitutional audit hook** (`src/layers/constitutional-audit.ts`) — a Sprint-3 contract surface, **still not implemented**. The LASSO rule selection, ANFIS compliance scoring, and mirror test remain stubs; the layer is gated OFF by default (`CONSTITUTIONAL_AUDIT_ENABLED=false`) and does not influence scoring. No constitutional compliance is measured today.
3. **Behavioral-integrity / defended-deception layer** (`src/engine/behavioral-integrity.ts`) — a **separate, new** layer (not the constitutional-audit stub). It computes an asymmetric penalty for *defended deception* but runs **shadow-first**: gated by `TRUST_DECEPTION_MODE`, which defaults to `shadow`, so it **computes but never mutates live RepID** — enforce mode is off by default. See [Behavioral integrity](#behavioral-integrity--defended-deception-shadow-mode) below.
4. **Decay** (`src/layers/decay.ts`) — 30-day activity-based decay.
5. **Ecosystem need weight** (`src/layers/ecosystem-need.ts`) — supply-rate multiplier.
6. **Delta** — challenge events via `scoreChallengeOutcome`, predictions via `scorePrediction`, others via the `FIXED_DELTAS` table.
7. **Redemption modifier** — dampens negative deltas for prosocial agents.
8. Clamp to `[10, 10000]`, derive tier via `computeTier`.
9. Write back; append to `repid_score_events`; update `repid_ecosystem_supply`; award badges.

---

## Run locally

```bash
npm install --legacy-peer-deps   # required (matches nixpacks.toml)
npm run dev                       # ts-node src/index.ts
npm run build                     # tsc → dist/
npm start                         # node dist/index.js
npm test                          # jest
```

The repo expects `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in the environment (see `.env.example`).

---

## Sprint discipline: pre-commit hook

A pre-commit hook prevents the HEAD-drift contamination pattern that surfaced during heavy multi-agent sprint windows. Multi-agent sprints in shared working trees can silently land commits on the wrong branch; the hook blocks that.

**Install once per clone:**

```bash
npm run install:hooks
```

**At the start of every sprint, set your expected branch:**

```bash
echo "feat/your-sprint-branch-name" > .git/EXPECTED_BRANCH
```

Bypass for emergencies: `git commit --no-verify`.

Source: `scripts/git-hooks/pre-commit.sh`; installer: `scripts/git-hooks/install.sh`; tests: `tests/git-hooks.test.ts`.

---

## Contributing

Contributions welcome. Open an issue first for substantial changes so we can align on scope.

For security-relevant findings (RepID gaming, on-chain attack surfaces, HAL bypasses), please follow responsible disclosure — open a GitHub Security Advisory rather than a public issue.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).

---

**Part of the HyperDAG Protocol ecosystem.**

- [TrustShell](https://trustshell.dev) — SDK
- [TrustRepID](https://trustrepid.dev) — Reputation leaderboard
- [TrustChat](https://trustchat.dev) — Consumer experience
- [HyperDAG Protocol](https://github.com/DealAppSeo/hyperdag-protocol) — Protocol spec

ERC-8004 compatible. Apache 2.0 licensed. Micah 6:8.

**On-chain footprint (Base Sepolia, chain ID 84532):**
- IdentityRegistry — [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://sepolia.basescan.org/address/0x8004A818BFB912233c491871b3d84c89A494BD9e)
- ReputationRegistry — [`0x8004B663056A597Dffe9eCcC1965A193B7388713`](https://sepolia.basescan.org/address/0x8004B663056A597Dffe9eCcC1965A193B7388713)
