# x402 site/spend gate

A short pointer doc for the x402 spend surface in `repid-engine`.

## What it is

The engine exposes several x402-related paths, but none of them are wired to a hosted site UI today:

- `src/services/x402-gate.ts` — `decideAuthority` is a pure, tier-based USDC spend policy (`PROBATIONARY` through `VETERAN`); `checkTransactionAuthority` loads live context and audits every decision to `x402_payment_gates`.
- `src/routes/mvp-api.ts` exposes the gate over HTTP:
  - `POST /api/v1/mvp/x402-gate/authorize`
  - `GET /api/v1/mvp/x402-gate/limits/:agent`
  - `GET /api/v1/mvp/x402-gate/history/:agent`
- `src/routes/agents.ts` has an older `POST /agents/:id/x402-gate` tier check. It uses different tier limits than `x402-gate.ts` and should be treated as a separate, stubbier path.
- `src/routes/x402-inbound.ts` is a 402 Payment Required demo endpoint: `POST /api/v1/x402/:uuid/trade-analysis`. It builds payment requirements, verifies/settles an `X-PAYMENT` header, and records the result. Real analysis is gated behind `X402_DEMO_ANALYSIS=true`; otherwise it returns `not_implemented` after settlement.
- `src/services/x402-server.ts` backs the tip flow mounted at `POST /api/v1/tip/request` and `POST /api/v1/tip/deliver/:tipId` (`src/routes/v1.ts`). Settlement is simulated unless `X402_REAL_RPC=true`.

So the repo has the policy function, audit table, HTTP wrappers, and two small demo/settlement surfaces, but the "site" part — a hosted web UI that originates an x402 payment — is not present.

## What is NOT checked / not shipped

- **No hosted page on `trustrepid.dev` (or any engine-hosted site) spends via x402 today.** The engine is an API; it has no frontend that calls these endpoints on behalf of a visitor.
- **Whether `X402_ENFORCEMENT_ENABLED` is on in production is NOT_CHECKED from this file.** `POST /escrow` (`src/routes/v1/contracts.ts`) only enforces the authority gate when that flag is `true`; the default legacy branch moves `pending` → `escrowed` with no payment presented. The shadow observation runs unless `X402_GATE_SHADOW=false`.
- **Whether `X402_REAL_RPC` is on is NOT_CHECKED from this file.** Tip and inbound trade-analysis settlement are simulated without it.
- **Whether the shadow observers (`OWNER_CEILING_SHADOW_ENABLED`, `STAKE_AUTHORITY_SHADOW_ENABLED`) are on is NOT_CHECKED from this file.** They record gaps but change no live decision.
- **Browser wallet handling for a site spend UI is not in the tree.** Any future site flow would need to solve key custody in the browser, set a cap, and call one of the gated endpoints. That is not implemented.

## No stake claims here

This doc is about the **spend/authority gate surface**, not about staking. It does not enable, flip, or describe `REAL_STAKING_ENABLED`, `HUMAN_AGENT_BIND_ENABLED`, or any stake/ownership flag. For those, see `src/routes/admin-flags.ts` (behind `ADMIN_KEY`) and `src/config/flag-readiness.ts` (public readiness), not this file.

## Where to go next

- Spend authority policy: [`src/services/x402-gate.ts`](../src/services/x402-gate.ts)
- HTTP gate surface: [`src/routes/mvp-api.ts`](../src/routes/mvp-api.ts)
- Escrow shadow observation: [`src/routes/v1/contracts.ts`](../src/routes/v1/contracts.ts)
- Inbound 402 demo: [`src/routes/x402-inbound.ts`](../src/routes/x402-inbound.ts)
- Tip request/delivery: [`src/services/x402-server.ts`](../src/services/x402-server.ts) and [`src/routes/v1.ts`](../src/routes/v1.ts)
- Human spend shadow (decides nothing live): [`src/services/human-spend-shadow.ts`](../src/services/human-spend-shadow.ts)
- Flag reporter (admin): [`src/routes/admin-flags.ts`](../src/routes/admin-flags.ts)
