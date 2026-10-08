# repid-engine

> Open-source reputation backend for AI agents. ERC-8004 identity oracle and x402 payment coordinator. Powers the HyperDAG Protocol Trust ecosystem.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Standard: ERC-8004](https://img.shields.io/badge/Standard-ERC--8004-blue)](https://github.com/DealAppSeo/hyperdag-protocol)
[![Network: Base Sepolia](https://img.shields.io/badge/Network-Base_Sepolia-success)](https://sepolia.basescan.org/)
[![HAL: live](https://img.shields.io/badge/HAL-live-success)](#hal--hallucination-auditor-layer)

`repid-engine` is the API and scoring engine of the HyperDAG Protocol Trust\* ecosystem. What it calls, and what calls it, is in [Where this sits](#where-this-sits).

Three things to know before reading further:

- **Most score changes stay off-chain.** A write to the ERC-8004 ReputationRegistry happens only on the paths listed in [When a reputation write goes on-chain](#when-a-reputation-write-goes-on-chain), and the two automatic paths skip any agent below a RepID of 1000.
- **The main scoring path keeps an audit row.** `updateRepId` (`src/engine/repid-update.ts`) writes a row to `repid_score_events` before it moves a score. Other services under `src/services/` also write `current_repid` directly; this README does not claim that each of them writes that row.
- **Every endpoint under [Public API](#public-api) is readable without a key.**

If you are building on the ecosystem from outside, start from [BUILDERS.md](https://github.com/DealAppSeo/hyperdag-protocol/blob/main/BUILDERS.md), not this README. BUILDERS.md is the published contract. This README describes the engine's internals and changes without notice.

---

## Where this sits

This section names only what the engine calls and what calls it. The whole map is in **[BUILDERS.md — How the pieces fit](https://github.com/DealAppSeo/hyperdag-protocol/blob/main/BUILDERS.md#how-the-pieces-fit)**.

`tests/readme-edges.test.ts` fails if the edges below that live in this repo (the prover URL, the verifier dependency, the registry addresses, the controller address) stop matching the code.

**Calls:**

- **The prover** — [DealAppSeo/HyperDAG-core](https://github.com/DealAppSeo/HyperDAG-core) `services/zkp-postcard`, at https://zkp-postcard-production.up.railway.app. That URL is the one default in `src/config/prover.ts`; `ZKP_SERVICE_URL` overrides it per service. The scoring pipeline (`src/scoring/pipeline.ts`), the external-agent routes (`src/routes/agents-external.ts`), the proof-refresh worker (`src/workers/proof-refresh-worker.ts`) and the proof-drain worker (`src/scripts/start-proof-drain-service.ts`) all read it.
- **`@hyperdag/proof-verifier`** — a dependency in `package.json`, installed from [DealAppSeo/hyperdag-proof-verifier](https://github.com/DealAppSeo/hyperdag-proof-verifier) at a pinned commit. The engine uses it to check proofs locally (`src/services/handlers/zkp-audit-handler.ts`, `src/routes/v1.ts`).
- **The ERC-8004 registries on Base Sepolia** (chain ID 84532), addresses in `src/config/network.ts`:
  - IdentityRegistry — [`0x8004A818BFB912233c491871b3d84c89A494BD9e`](https://sepolia.basescan.org/address/0x8004A818BFB912233c491871b3d84c89A494BD9e)
  - ReputationRegistry — [`0x8004B663056A597Dffe9eCcC1965A193B7388713`](https://sepolia.basescan.org/address/0x8004B663056A597Dffe9eCcC1965A193B7388713)

  The engine reads both. It writes reputation only on the paths in [When a reputation write goes on-chain](#when-a-reputation-write-goes-on-chain).
- **The controller** at https://controller.aitrinitysymphony.com, for human-in-the-loop escalations. The engine records the escalation in Supabase and sends the operator a link to it in the controller (`src/services/escalation-router.ts`, `src/services/hitl-notification-dispatcher.ts`). `CONTROLLER_APP_URL` overrides the address. The engine does not call the controller's API.
- **Supabase** (Postgres) — all engine state. The schema is managed outside this repo; `CLAUDE.md` lists the tables the engine uses.

It also calls, and the test does not pin: the LLM providers in the HAL quorum (`src/hal/fact-check.ts`; hosts in `src/egress/provider-hosts.ts`), EAS on Base Sepolia for proof attestations (`src/services/eas-attestation-service.ts`), the HashKey testnet RPC (`src/engine/hashkey-chain.ts`), and Telegram for operator alerts (`src/routes/telegram.ts`).

**Called by** (each found in that repo's own code):

- **[DealAppSeo/trustshell](https://github.com/DealAppSeo/trustshell)** ([trustshell.dev](https://trustshell.dev)), which ships `@hyperdag/trustshell`, the package outside builders install:
  - the SDK — `src/lib/trustshell.ts`
  - the CLI — `src/cli/status.ts`
  - the MCP server — `src/mcp/index.ts`, through the SDK
  - the site — `components/live-trust-scores.tsx`
  - the browser extension — `extension/select.js`, which calls `POST /api/v1/classify`
- **The house agents** in [DealAppSeo/trinity-symphony-shared](https://github.com/DealAppSeo/trinity-symphony-shared) — `lib/ConstitutionalAgentV4.js` posts peer-verification verdicts to `/api/v1/peer-verification/respond`, and `lib/swarm-toolbelt.js` reads `/api/v1/stats`.
- **[DealAppSeo/trustrepid](https://github.com/DealAppSeo/trustrepid)** ([trustrepid.dev](https://trustrepid.dev)) — for example `app/hal/LiveStatsBanner.tsx` and `app/components/ActivityFeed.tsx`.
- **[DealAppSeo/repid](https://github.com/DealAppSeo/repid)** (repid.dev) — for example `app/start/page.tsx` and `app/agent/[id]/page.tsx`.
- **[DealAppSeo/trustrails-dev](https://github.com/DealAppSeo/trustrails-dev)** — `app/stake/page.tsx`.
- **[DealAppSeo/hyperdag-landing](https://github.com/DealAppSeo/hyperdag-landing)** — `index.html` reads `/api/v1/leaderboard/models` and `/api/v1/hal/stats`.

---

## The target system, and what of it exists

HyperDAG Protocol is a **portable trust harness**: it makes an AI agent's reputation mean
something to a counterparty who had no part in producing it. Four links, in order —
**HAL** decides whether the agent is telling the truth, **RepID** turns that history into a
score, **zkRepID** makes the score checkable without revealing it, and **x402 + ERC-8004**
make it spendable and recordable on someone else's rails.

This table is the shared vocabulary. It carries a status column because the words below are
the *target*, and several of them name nothing yet — a doc that reads as though they were all
shipped is how parallel work drifts.

| Term | What it means | Status |
| :-- | :-- | :-- |
| **Earned trust** (weighted + earned) | Reputation has two components: *earned* — what the agent actually did, scored per event — and *weighted* — how much that evidence counts, given who observed it and what they had at stake. Today only the earned half is computed. | **PARTIAL** — earned is live; weighting is not implemented |
| **Issuer-staked reputation** | Whoever issues an attestation stakes on it, so vouching carries downside and a cheap voucher cannot inflate a score. | **TARGET** — no issuer-stake exists in this repo (measured 2026-08-17) |
| **Decay-unless-re-earned ratchet** | Reputation decays with inactivity and must be *re-earned* rather than restored — so a lapse costs work to undo, and a high score always describes recent behaviour. | **PARTIAL** — activity-based decay is live (`src/layers/decay.ts`); the ratchet is not built |
| **Selective disclosure** (threshold proof, not confession) | A holder proves a *predicate* — "my RepID is at least X" — without revealing the score, the events behind it, or their identity. It is a threshold proof, **not** a confession: nothing is disclosed in order to be believed. | **TARGET** — the deployed proof statement carries `repid_score` and `tier` in the clear next to the threshold (`src/zkp/proof-statement-guard.ts`), so today's proofs disclose the score. The new statement family in `src/zkrepid/disclosure.ts` has no circuit yet. |
| **Dual-auth** | An action needs two independent authorities, so neither a compromised agent nor a compromised host can act alone. | **PARTIAL** — the fail-closed gate is `src/services/dual-auth-gate.ts`. The trust-harness demo runs it, and a rating is admitted only against a stored outcome whose `gate_decision` is `ALLOW` (`src/routes/v1/ratings.ts`). No live request path runs the gate itself. |
| **zkRepID** | The RepID-specific proving surface (`src/zkrepid/`), canonical since 2026-08-17. General ZK machinery — Poseidon2, Plonky3, hash-agnostic Merkle — keeps the name `zkp`. | **BUILT** — boundary enumerated in `src/zkrepid/boundary.ts` and pinned by tests |

**Two rules this table exists to enforce.** Do not soften a claim to match the build — build
the claim or delete it. And never report a later link working as an earlier one working: a
zkRepID proof is faithful to whatever number RepID produced, so *"the proof verifies"* is not
evidence that the incentives are right. That distinction was measured, not assumed — see
`reports/2026-08-17/REPID-INCENTIVE-AUDIT.md` (`npm run repid:sim`).

---

## When a reputation write goes on-chain

Most score changes stay in Supabase. A write to the ERC-8004 ReputationRegistry happens only on these paths:

1. **The feedback-loop worker** (`src/workers/feedback-loop-worker.ts`). Every 60 seconds it reads unprocessed `repid_events` rows whose type is in `ONCHAIN_ELIGIBLE_EVENT_TYPES` (`src/workers/feedback-loop-filters.ts`): x402 settlements in either direction, settled service contracts, peer-verification verdicts, and red-team adjudications. It drops simulated rows and placeholder transaction hashes. It writes only for an agent that holds an `erc8004_token_id` and has a `current_repid` of at least 1000. It runs unless `ENGINE_WORKERS_ENABLED=false`.
2. **Inline, when a service contract settles** (`maybeWriteOnChainReputation` in `src/services/onchain-reputation-trigger.ts`, called from `src/services/validation-repid-delta.ts`). Same rules: never for a simulated settlement, only with a token id, only at 1000 or above. It is off unless `ONCHAIN_REPUTATION_TRIGGER_ENABLED=true`. When it is off or fails, path 1 picks up the same event.
3. **An operator write**, `POST /api/v1/agents/:id/reputation/write` (`src/routes/agents-reputation.ts`), behind an API key. It needs a token id and has no score floor.
4. **The demo trading round** (`src/services/anonymous-round-runner.ts`), which writes for the two house trading agents it runs.

Every path needs a signing key in the engine's environment. Without one, nothing is written: the worker and the inline trigger log the skip, and the operator route answers 503. The current count of writes a reader can check on basescan is at `GET /api/v1/observability/onchain-stats`.

---

## Run the trust harness end-to-end

One command walks a proposed agent action through every leg of the harness against **live systems** — no mock, no fixture, no fallback that invents a value. A leg that cannot run is printed as a gap, not papered over.

```bash
npm install --legacy-peer-deps
npm run build                   # the demo imports helpers from dist/
npm run demo:harness            # add --agent <name> --claim "<statement>" to vary the action
```

Each run reports, per leg, whether it hit a `REAL` system:

1. **HAL** — scores the action via a live cross-provider quorum; a hallucinated claim is vetoed with a *calibrated* confidence (temperature-scaled, not a raw score). The calibration was fitted on the frozen rigorous-v1 holdout split, which has been public since July and was retired as a holdout on 2026-10-07 (`eval/holdout/README.md`).
2. **RepID** — the actor's live reputation and tier (keyless read).
3. **ZK range proof** — fetched, then **verified locally** with `@hyperdag/proof-verifier`. The proof shows the score clears a threshold. It does not hide the score: the proof's public statement includes it (see *Selective disclosure* above).
4. **Poseidon2** — a scoped nullifier from the Rust primitive: same secret, different scope → different nullifier (one identity, many domains).
5. **On-chain** — reads the count of on-chain reputation writes from `/api/v1/observability/onchain-stats` and prints the two registry addresses. It does not fetch or check a specific attestation. `REAL` here means that endpoint answered.
6. **Outcome + fold** — classifies the result, requires a payment proof for a reward, and folds the delta into a committed Poseidon2/BabyBear root.
7. **Dual-auth gate** — allows only with **both** agent and human authority, and **fail-closed**: if HAL vetoed, the gate REFUSES even when both authorities are present, and lists every blocker so fixing one cannot hide the next.

The demo asserts only what it proves in-circuit and marks the rest explicitly (e.g. a score *decrease* is unrepresentable in unsigned field arithmetic, so that constraint is stated as vacuous rather than claimed). The footer prints the state of each leg, for example `legs: hal=REAL repid=REAL proof=REAL nullifier=REAL anchor=REAL fold=REAL`.

`REPID_API_KEY` is **not** required — every leg reads a public surface. Without it, the HAL call uses the public endpoint, which is capped per IP (`HAL_PUBLIC_RATE_LIMIT`). The Poseidon2 leg needs the `babybear-leaf` binary (`LEAF_BIN`, built from the ZKP crate); without it that single leg reports a gap and the rest still run.

---

## Public API

Production base URL: `https://repid-engine-production.up.railway.app`

All endpoints below are **public — no API key required**. This is not the full list of public routes; `src/index.ts` mounts them, and `src/middleware/auth.ts` lists the GET paths that skip the key check.

**CORS.** Browsers may call the engine from the origins in `src/utils/cors-origins.ts`: a list of named origins (including trustrepid.dev, trustshell.dev, hyperdag.org and repid.dev), any `https://trust*.dev` host, any `hyperdag.org` subdomain, `hyperdag*.vercel.app` previews, and localhost on ports 3000 and 3001. Requests with no `Origin` header (curl, servers) are allowed. `POST /api/v1/classify` sets its own CORS that allows any origin.

Numbers in the examples below are placeholders. Call the endpoint for the current value.

### `GET /api/v1/passport/:agentId`

**Agent Trust Passport** — the one-call composite for "should I authorize this agent?": RepID + tier, ERC-8004 identity metadata with a link to a live on-chain ownership check, x402 real-vs-simulated settlement history, on-chain reputation write count, and the latest ZKP proof labeled honestly (a range proof over the score; it does not attest agent behavior). `:agentId` accepts a UUID, an ERC-8004 token id, or an agent name.

```bash
curl https://repid-engine-production.up.railway.app/api/v1/passport/trinity-shofet
```

### `GET /api/v1/status`

Consolidated health + 24h economic activity (`src/routes/v1/launch-status.ts`).

```bash
curl https://repid-engine-production.up.railway.app/api/v1/status
```

```text
{
  "service": "repid-engine",
  "version": "1.0.0",
  "network": "base-sepolia",
  "timestamp": "<ISO time>",
  "operational": { "supabase": true },
  "metrics_24h": {
    "onchain_attestations": <count in the last 24h>,
    "real_settlements": <count in the last 24h>,
    "score_events": <count in the last 24h>,
    "firecrawl": { "enabled": true, "calls": <n>, "cost_usd_24h": <n>, "by_agent": [...], "note": "..." }
  },
  "last_heartbeat": { "at": "...", "result": ... } or null,
  "audit_status": { "at": "...", "overall": "..." } or null,
  "hero_receipt": "/api/v1/receipts/hero"
}
```

A count is `null` when its query failed. `null` is not zero.

### `GET /api/v1/receipts/hero`

One recorded example of the full economic loop: a USDC settlement on chain, then a reputation write on chain. Both transaction hashes are real and clickable. It is a fixed record in `src/routes/v1/launch-status.ts` (`HERO_RECEIPT`), not a live query. The example below leaves out three fields the endpoint also returns: `contract_id` and the operator and provider wallet addresses.

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
    "block": 41917330,
    "basescan": "https://sepolia.basescan.org/tx/0x2a7ac151c23983f59564fc3da5c7ea74fdbe390f9e97fcbf70c79be27089967a"
  },
  "reputation_attestation": {
    "tx": "0xd362c1b0c819e2e1ee7bce601531afb0be1eef20c1be4ab8dc643e524d19e917",
    "block": 41917386,
    "registry": "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    "basescan": "https://sepolia.basescan.org/tx/0xd362c1b0c819e2e1ee7bce601531afb0be1eef20c1be4ab8dc643e524d19e917"
  },
  "settled_at": "2026-05-24T06:09:07Z"
}
```

### `GET /api/v1/hal/stats`

HAL (Hallucination Auditor Layer) production statistics — lifetime and last-24h counts, and the current quorum's providers and model families.

```bash
curl https://repid-engine-production.up.railway.app/api/v1/hal/stats
```

### `GET /api/v1/repid/:agentId`

Per-agent RepID lookup: score and tier only (`src/routes/repid.ts`). `:agentId` accepts an agent name or UUID.

```bash
curl https://repid-engine-production.up.railway.app/api/v1/repid/trinity-sophia
```

```text
{ "score": <integer from 10 to 10000>, "tier": "<tier name>" }
```

- An unknown agent returns `{ "score": "NOT_CHECKED", "tier": "NOT_CHECKED" }` with status 200. It never returns 0 for an agent it did not find.
- `?with=id` adds `"agent_id"`, the UUID the name resolved to, so a client can bind a proof to the agent it asked about.

Tier scale: `PROBATIONARY` (0–499) → `EARNING` (500–999) → `ESTABLISHED` (1,000–4,999) → `AUTONOMOUS` (5,000–7,999) → `VETERAN` (8,000–10,000). The stored tier is set by a database trigger, not by the engine. That trigger also requires at least two distinct counterparties for `AUTONOMOUS` and `VETERAN` (`supabase/migrations/20260523140000_repid_inflation_counterparty_gate.sql`), so a high score can sit in `ESTABLISHED`. See [BUILDERS.md section 4](https://github.com/DealAppSeo/hyperdag-protocol/blob/main/BUILDERS.md#4-anti-sybil-why-a-high-score-may-not-get-the-tier-you-expect).

### `GET /api/v1/llm-trust`

Per-LLM hallucination-rate leaderboard: a list with one entry per provider and model.

```bash
curl https://repid-engine-production.up.railway.app/api/v1/llm-trust
```

### `GET /api/v1/firecrawl/stats`

Firecrawl research-tool rollout statistics (calls + cost over the last 24h).

```bash
curl https://repid-engine-production.up.railway.app/api/v1/firecrawl/stats
```

### `GET /api/v1/agents/minted`

Every agent holding an ERC-8004 token (`repid_agents` where `erc8004_token_id IS NOT NULL`), ordered by RepID (`src/routes/v1/observability-public.ts`). Adversarial mock agents are excluded by default; pass `?include_mock=true` to include them.

```bash
curl https://repid-engine-production.up.railway.app/api/v1/agents/minted
```

```text
{
  "agents": [
    {
      "name": "<agent name>",
      "display_name": "<display name, or the agent name>",
      "agent_id": "<agent id>",
      "erc8004_token_id": "<token id>",
      "current_repid": <integer>,
      "tier": "<stored tier>"
    }
  ],
  "count": <number of agents in the list>
}
```

### `GET /api/v1/observability/onchain-stats`

On-chain counters, read from the database on every call.

```bash
curl https://repid-engine-production.up.railway.app/api/v1/observability/onchain-stats
```

```text
{
  "agents_minted": <agents with a token id, mock agents excluded>,
  "lifetime_onchain_writes": <writes with a real tx hash on the canonical ReputationRegistry>,
  "onchain_writes_excluded_unverifiable": <rows left out because a reader could not check them on basescan>,
  "as_of": "<ISO time>"
}
```

### `GET /.well-known/agent.json` (+ `/agent.json` alias)

AGNTCY-style agent card. Lists capabilities, protocols, and trust attestations.

```bash
curl https://repid-engine-production.up.railway.app/.well-known/agent.json
```

---

## HAL — Hallucination Auditor Layer

`src/hal/lib/` is the callable HAL library. `evaluate()` (`src/hal/lib/evaluate.ts`) takes a strictness level from 1 to 5 (default 4). What each level adds, read from the code:

| Level | What runs |
| :-- | :-- |
| 1 | The extractor and the score only. No other model is asked. |
| 2 | Adds the cross-LLM check, when the caller passes `providers` and a `prompt`. It asks the providers, measures how much their answers agree (embedding similarity if an `embeddingClient` is given, word overlap otherwise), and vetoes when the Pythagorean Comma check rates the disagreement `critical`. If a `classifierProvider` is given, this layer runs only for prompts classed as factual, time-sensitive or math. |
| 3 | **Nothing beyond level 2.** `evaluate.ts` has no branch for level 3; the Comma critical veto already runs at level 2. The comment in `src/hal/lib/types.ts` and `docs/HAL_LIBRARY_API.md` describe level 3 as adding that veto; the code does not. |
| 4 | Adds the three-zone agreement band (too tight / in band / too loose, `src/hal/lib/zones.ts`). When agreement is in band, it compares the claim to the consensus answer and vetoes if they contradict (`src/hal/lib/claim-comparison.ts`). |
| 5 | Adds a `tampering_suspected` flag when agreement is above the tight threshold. The flag does not veto. |

At every level, the score itself also vetoes when it reaches the threshold. `evaluate()` scores `claimText`; the `output` argument is accepted and returned, but not scored.

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

`src/engine/behavioral-integrity.ts` adds a behavioral-integrity layer that targets **defended deception** — the failure mode where an agent's own account of events cannot be trusted (the "I never said that" defense). Rather than asking a model to adjudicate, it checks each new interaction against a **keccak256 hash-chained interaction record** (the same primitive as `evidenceHash` in `src/engine/hashkey-chain.ts`, so a receipt root is anchorable on-chain with no new crypto). Tampering with any prior receipt breaks every hash after it.

The penalty is **asymmetric by design**: an honest wrong answer stays cheap (so agents surface it), while a *confirmed, grounded* defended-deception event is penalized several times heavier. The asymmetry is the mechanism.

Two tiers of detector, honestly separated:

- **Record-grounded classes** — denial-of-prior-output, fabricated citation/tool-result/benchmark, story-change-across-turns. These fire **only** on a provable mismatch against the chain.
- **Heuristic classes** — doubt-attack, sycophancy (false-premise), threshold-dancing. These are **advisory only**, interpretable pattern signals marked with lower confidence, and weaker on paraphrase.

Guards keep the detectors from penalizing first-time citations, honest self-corrections, and scoped restatements. The heavy penalty applies **only** on a confirmed grounded detection, and **only** in enforce mode.

No accuracy figure is given here: no eval of these detectors with a corpus and a date is recorded in this repo. The tests are the evidence of behavior: detectors in `tests/behavioral-integrity.test.ts`, the shadow/enforce gate in `tests/trust-keystone-deception.test.ts`.

**Mode gate — shadow-first (`TRUST_DECEPTION_MODE`):**

| mode | behavior |
|---|---|
| `shadow` (**default**) | Computes the would-be penalty and records it in the audit row, but **never mutates `current_repid`** (truly inert — no delta, no decay, no activity bump). Enforcement is never incidental. |
| `enforce` | Applies the penalty — **only** on a confirmed grounded detection. |

So today this layer is a **measurement**, not an enforcement: it observes without touching live scores.

---

## Evaluation

Two re-runnable, known-answer harnesses keep the accuracy claims reproducible. Every number below is a dated measurement on a named corpus. A re-run today may use a different quorum, which makes it a different ruler; do not compare across them.

### Canary HAL-accuracy F1

`scripts/eval/canary-f1.ts` runs the **real cross-LLM HAL quorum** (`src/hal/fact-check.ts`) locally with live keys against a fixed known-answer oracle, `eval/canary/canary-corpus-v1.1.jsonl` (47 claims after a source spot-check dropped 3 rows from the original 50).

```bash
npx ts-node scripts/eval/canary-f1.ts   # loads provider keys from ../.env.master (one level above the repo), else a local .env
```

Recorded in the 2026-07-07 report, on that 47-claim corpus: F1 ≈ 0.95 (precision 0.905, recall 1.00, accuracy 0.957; TP 19 / FP 2 / TN 26 / FN 0). This is an **easy, small known-answer set, not a benchmark**; the 337-item eval below is the harder measurement. Full run: [`reports/2026-07-07/CANARY_HAL_F1_BASELINE.md`](reports/2026-07-07/CANARY_HAL_F1_BASELINE.md).

### Rigorous 337-item HAL eval

The same real cross-LLM quorum over a **337-item fully-provenanced corpus** (FEVER + HaluEval + TruthfulQA + the in-repo canary), bootstrap 95% CIs, run 2026-07-09:

- **F1 ≈ 0.80 [0.75–0.84]**, **recall ≈ 0.95**, **AUC ≈ 0.90**, **ECE 0.056**.

Caveats (state these wherever the number appears):

- The quorum's real edge is **recall + vendor-independence, NOT raw accuracy** — a single strong model (DeepSeek, F1 ≈ 0.86 at full coverage) edged the quorum on F1 in that run; the quorum's value is not depending on any one vendor's uptime or honesty.
- In that run, model independence was partial: some hosts served identical weights (e.g. Groq + DeepInfra both ran Llama-3.1-8B; error-correlation ≈ 0.88). The quorum's members have changed since (the live list is in `GET /api/v1/hal/stats`), which is one reason a re-run is a different ruler.
- As of that report, the number had not been independently replicated.

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

Express API + Supabase Postgres + Plonky3 range proofs from the prover, with EAS attestations on Base Sepolia + ERC-8004 reputation writes on Base Sepolia.

### Request pipeline (`src/index.ts`)

The order of the `app.use(...)` calls, top to bottom. `tests/readme-edges.test.ts` fails if this order stops matching the code, or if a global middleware is added to `src/index.ts` without being listed here.

```text
helmet()
→ classifyRouter, telegramPublicRouter    public doors; each brings its own CORS, body limit and rate limit
→ cors(...)                               allow-list in src/utils/cors-origins.ts
→ express.json(...)                       1mb body limit
→ attestationExtractorMiddleware          reads an optional RepID attestation header
→ globalRateLimit()                       src/middleware/rate-limit.ts
→ JSON parse-error handler                malformed JSON becomes a 400
→ emergencyHaltMiddleware(db)             kill switch for mutating requests; GET and HEAD pass
→ fullAccountRouter                       ahead of the sanitizer on purpose
→ SQL-keyword sanitizer                   POST bodies only, with per-path exemptions
→ public routers                          no key needed
→ readinessRouter
→ authMiddleware                          API key required from here, except the paths it bypasses
→ repidConfessRouter, socialQueueRouter, llmRouter
→ rateLimitMiddleware                     src/middleware/rateLimit.ts; lets requests through when Redis is not connected
→ versioningMiddleware                    X-RepID-Version
→ authed routers
```

### Provider resilience

The HAL cross-LLM quorum (`src/hal/fact-check.ts`) counts one vote per model family, so two hosts of the same base model count once. When providers fail or rate-limit, the quorum **auto-backfills the next cheapest live families** (on unless `HAL_QUORUM_AUTOBACKFILL=false`), with OpenRouter as the last-resort family, so a burst of 429s still reaches a quorum instead of collapsing to the extractor. The live member list is in `GET /api/v1/hal/stats` (`quorum_family_names`).

### Scoring pipeline (`src/engine/repid-update.ts`)

`updateRepId` runs these steps in this order:

1. Fetch the agent from `repid_agents`.
2. **Constitutional audit hook** (`src/layers/constitutional-audit.ts`) — a Sprint-3 contract surface, **still not implemented**. The LASSO rule selection, ANFIS compliance scoring, and mirror test remain stubs; the layer is off by default (`CONSTITUTIONAL_AUDIT_ENABLED`) and does not influence scoring. No constitutional compliance is measured today.
3. **Decay** (`src/layers/decay.ts`) — 30-day activity-based decay.
4. **Ecosystem need weight** (`src/layers/ecosystem-need.ts`) — scales the delta for challenge events only (`src/layers/challenge-scoring.ts`). For every other event type it is recorded in the audit row and changes nothing.
5. **Delta** — challenge events via `scoreChallengeOutcome`, predictions via `scorePrediction`, defended-deception events via `gatedDeceptionDelta` (the heavy penalty needs a confirmed proof), and the rest from the `FIXED_DELTAS` table (`src/scoring/repid-deltas.ts`). `STAKE` earns nothing here.
6. **Redemption modifier** — dampens negative deltas for prosocial agents.
7. **Shadow gate** — in `shadow` mode (the default), a defended-deception event leaves the score unchanged. See [Behavioral integrity](#behavioral-integrity--defended-deception-shadow-mode).
8. Clamp to `[10, 10000]`. The engine computes a tier, but the stored tier is set by the database trigger described under [`GET /api/v1/repid/:agentId`](#get-apiv1repidagentid).
9. Write the audit row to `repid_score_events` first, then the new score to `repid_agents`.
10. Update `repid_ecosystem_supply`, then check badges. Badge failures never break scoring.

---

## Run locally

```bash
npm install --legacy-peer-deps   # required (matches nixpacks.toml)
npm run dev                       # ts-node src/index.ts
npm run build                     # tsc → dist/
npm start                         # node dist/index.js
npm test                          # jest
```

The engine will not start without `SUPABASE_URL` and a service key: `SUPABASE_SECRET_KEY`, or one of the older names `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SERVICE_KEY` (`src/config.ts`). `.env.example` lists the variable names with empty values, so a fresh clone does not boot until you set them.

---

## Sprint discipline: pre-commit hook

A pre-commit hook prevents the HEAD-drift contamination pattern that surfaced during heavy multi-agent sprint windows. Multi-agent sprints in shared working trees can silently land commits on the wrong branch; the hook blocks that.

**Install once per clone, and once per extra worktree:**

```bash
npm run install:hooks
```

This runs `scripts/install-hooks.ts`, which copies `scripts/git-hooks/pre-commit.sh` into the active worktree's git directory.

**At the start of every sprint, set your expected branch.** The file lives in the git directory, which is `.git/` in a normal clone and `.git/worktrees/<name>/` in a worktree, so ask git for it:

```bash
echo "feat/your-sprint-branch-name" > "$(git rev-parse --git-dir)/EXPECTED_BRANCH"
```

In Windows PowerShell:

```powershell
$gitDir = git rev-parse --git-dir
Set-Content -Path (Join-Path $gitDir 'EXPECTED_BRANCH') -Value 'feat/your-sprint-branch-name'
```

If the file is missing, the hook warns and allows the commit. Bypass for emergencies: `git commit --no-verify`.

Source: `scripts/git-hooks/pre-commit.sh`; installer: `scripts/install-hooks.ts`; tests: `tests/git-hooks.test.ts`.

---

## Contributing

Contributions welcome. Open an issue first for substantial changes so we can align on scope.

For security-relevant findings (RepID gaming, on-chain attack surfaces, HAL bypasses), please follow responsible disclosure — open a GitHub Security Advisory rather than a public issue.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).

---

**Part of the HyperDAG Protocol ecosystem.** How the pieces fit: [BUILDERS.md](https://github.com/DealAppSeo/hyperdag-protocol/blob/main/BUILDERS.md#how-the-pieces-fit).

ERC-8004 compatible. Apache 2.0 licensed. Micah 6:8.
