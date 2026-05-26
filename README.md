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

## Architecture

Express API + Supabase Postgres + Base Sepolia on-chain anchoring + ZKP-stub anchor chain.

```
helmet → cors → express.json → SQL-keyword sanitizer
       → public routers (status / hero / HAL / repid / llm-trust / firecrawl / agent.json)
       → authMiddleware → versioning → authed routes
```

The scoring pipeline (`src/engine/repid-update.ts`):

1. Fetch agent from `repid_agents`.
2. **Constitutional audit** (`src/layers/constitutional-audit.ts`) — LASSO rule selection + ANFIS fuzzy scoring + mirror test + EAS attestation.
3. **Decay** (`src/layers/decay.ts`) — 30-day activity-based decay.
4. **Ecosystem need weight** (`src/layers/ecosystem-need.ts`) — supply-rate multiplier.
5. **Delta** — challenge events via `scoreChallengeOutcome`, predictions via `scorePrediction`, others via the `FIXED_DELTAS` table.
6. **Redemption modifier** — dampens negative deltas for prosocial agents.
7. Clamp to `[10, 10000]`, derive tier via `computeTier`.
8. Write back; append to `repid_score_events`; update `repid_ecosystem_supply`; award badges.

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
