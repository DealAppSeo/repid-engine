# repid-engine

Behavioral reputation scoring engine. Powers the HyperDAG Protocol Trust* product
ecosystem. Private. Proprietary. Not for public distribution.

Docs: trustrepid.dev
Protocol: hyperdag.dev

## What this is

The Express service that mutates agent reputation (`repid`) scores in Supabase,
runs the constitutional / decay / ecosystem-need pipeline, and exposes the
ZKP proof-of-reputation, trader, builder, and demo endpoints. Deployed as
`repid-engine-production.up.railway.app` on Railway.

## Real vs simulated — read this honestly (CLAUDE-RULE-4)

The codebase mixes real on-chain integrations with deliberately-stubbed surfaces.
Every endpoint that returns a proof, attestation, or settlement carries a
`proof_source` / `is_simulated` field so callers can tell which is which. Do
not re-categorize without evidence.

| Surface | State | Notes |
|---|---|---|
| ERC-8004 IdentityRegistry (canonical, ChaosChain) | **Real** | APM + VERITAS registered as `agentId` 614 and 615 on the canonical registry. Writes to `IdentityRegistry.update(...)` for reputation events go through `src/services/erc8004-canonical-writer.ts`. |
| Telegram alerts (HAEE epoch, daily health, stalled tasks) | **Real** | `src/routes/telegram.ts` posts to a real bot via `TELEGRAM_BOT_TOKEN`. |
| Webhook delivery | **Real** | `src/services/webhook.ts` hits subscribed URLs with HMAC payload signatures. |
| Base Sepolia block-hash oracle (linked-bet outcomes) | **Real** | Reads block hashes from Base Sepolia RPC. Falls back to HMAC-signed outcome when RPC is unreachable; the bet response carries `oracle_source`. |
| Plonky3 ZKP prover bridge | **Real (with documented HMAC fallback)** | Real STARK proofs when the Axum prover service is up. `src/zkp/plonky3-real.ts` returns an HMAC-signed stub when it isn't. The proof response carries `proof_source: 'plonky3' \| 'hmac_fallback'`. The HMAC fallback is **not** zero-knowledge. |
| x402 settlement (HTTP 402 Payment Required) | **Real (Gemini Phase 3, in flight)** | Settler service is wired; listing here so we don't accidentally claim "simulated" once it lands. Track the flag in `is_simulated`. |
| Constitutional audit / mirror test / EAS attestation | **Stubs (Sprint 3)** | Always return `passed: true, score: 1.0`. Do not "fix" by hardcoding scores — these are contract surfaces. |
| Anonymous (token-only) builder address | **Demo-only by design** | `0xdead0e707…` prefix is hex-clean and parseable by `ethers.getAddress()` but is visibly distinguishable from a real wallet. Token-only builders have `earns_repid_rewards = false`. |
| Full-account JWT session tokens | **Real (HS256, vetted lib)** | `src/services/auth-token.ts` uses `jsonwebtoken` with `FULL_ACCOUNT_JWT_SECRET`. 7-day expiry. Replaces the prior hand-rolled HMAC scheme. |

## API documentation

### Environment configuration

- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — required at boot, set in Railway.
- `REPID_API_KEYS` — comma-separated `key:tier` pairs (e.g. `secret123:pro,corp_key:enterprise`).
- `REDIS_URL` — optional; rate limiter falls open without it.
- `FULL_ACCOUNT_JWT_SECRET` — required for `/api/v1/builder/full-signup` and `/api/v1/builder/login`.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — for HAEE / health alerts.
- `ALPACA_API_KEY`, `ALPACA_SECRET_KEY` — for the trading bridge (`paper-api.alpaca.markets`).
- `BASE_SEPOLIA_RPC_URL` — for the block-hash oracle.

### Middleware

- **Authentication**: most routes require `Authorization: Bearer <key>` or `x-api-key`. `GET /api/v1/repid/*` and `GET /api/v1/erc8004/validate/*` bypass auth. The live-demo public endpoints (`POST /api/v1/builder/token-signup`, `POST /api/v1/demo/run-round-anonymous`, `POST /api/v1/stake/deposit`) bypass key auth and are gated by an in-process per-IP rate limiter (10 requests / 60s) instead.
- **Versioning**: `X-RepID-Version` header (default `2026-04-17`).
- **Rate limits** (authenticated):
  - Free: 100 req/hour
  - Pro: 10,000 req/hour
  - Enterprise: unlimited

### Endpoints (selected)

- `GET  /api/v1/health` — liveness
- `GET  /api/v1/metrics` — public counters
- `POST /api/v1/prove-repid` — tiered ZKP proof of `repid_score`
- `POST /api/v1/verify-proof` — verify a proof (real Plonky3 or hmac_fallback)
- `POST /api/v1/builder/token-signup` — anonymous (token-only) builder
- `POST /api/v1/builder/full-signup` — email/password builder (JWT issued)
- `POST /api/v1/stake/deposit` — quadratic-authority stake deposit
- `POST /api/v1/demo/run-round-anonymous` — public APM/VERITAS round (rate-limited)
- `GET  /api/v1/demo/two-builder/snapshot` — Builder W and M state
- `POST /api/v1/trader/round/start` — Sean-signature-gated trading round
- See `src/routes/v1.ts` and `src/routes/full-account.ts` for the full surface.

## Tests

- `npm test` — Jest unit suite (mocked DB and external services). All tests pass on `feat/hardening-2026-04-28-jwt`.
- `npm run test:e2e` — hits the **live** Railway deployment. Soft-skips endpoints that aren't deployed yet; flips green once the deploy catches up. See `tests/e2e/README.md`.
- `npm run verify:alpaca` — places, polls, and cancels a paper Alpaca order. Requires `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` in env.

## Deploy

Railway + nixpacks. `nixpacks.toml` overrides install with `npm install --legacy-peer-deps` (intentional — a noble/hashes peer-dep conflict makes plain install fail). `railway.toml` runs `node dist/index.js`. No healthcheck (intentionally — see `5b24b58`). Server binds `0.0.0.0:$PORT`.

`src/index.ts` gates its side-effects (server bind, score-monitor cron, daily health cron, HAEE epoch cron, stalled-task cron) on `NODE_ENV !== 'test'` so Jest can import the app via supertest without leaking timers or sockets.

## See also

- `CLAUDE.md` — non-negotiable HyperDAG Protocol rules from Sean.
- `docs/REPONOMICS-API.md` — endpoint reference + Sean-signature recipe.
- `docs/REPONOMICS-FULL-ACCOUNT-FLOW.md` — full-account signup + login + paper trade walkthrough.
- `docs/TRADING-BRIDGE-ARCHITECTURE.md` — how the Alpaca bridge plugs into the round runner.
