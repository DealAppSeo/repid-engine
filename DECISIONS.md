# repid-engine V1 Launch Readiness: Key Architectural Decisions

This document summarizes the key design and architectural decisions made to harden `repid-engine` for production V1 launch readiness.

---

## 1. Dynamic Value Caps Evaluation
- **Decision**: Read and resolve safety caps in `getActiveNetwork()` dynamically from environment variables on each invocation, rather than binding them once at module load time.
- **Context**: The `NETWORKS` configuration was previously initialized at module import. This prevented unit and integration tests from dynamically adjusting safety limits via `process.env` during test execution (e.g., testing that 6 transactions trigger a 429 rate limit when the cap is 5).
- **Outcome**: Enabled granular test isolation and reliable simulation of safety threshold limits without module reloading or complex mock workarounds.

## 2. Table-Specific Mocking in DB Tests
- **Decision**: Avoid reusing a single, global chain mock for all table queries in tests. Instead, return specialized chain mock objects mapped to table names (e.g. `x402_settlements`, `service_contracts`).
- **Context**: Reusing the same chain object across distinct queries caused mock pollution (e.g. mock results from querying settlements were returned for contracts, or `.select().single()` threw due to missing mock methods in nested builder chains).
- **Outcome**: High-fidelity unit tests that cleanly verify database interaction patterns.

## 3. Multi-RPC Failover for Reputation Writing (D-026)
- **Decision**: Created `src/clients/rpc-with-failover.ts` and integrated it across all components that perform on-chain operations (`x402-facilitator`, `x402-outbound-client`, `repid-attestation`, and `erc8004-reputation`).
- **Context**: In V1 production, RPC outages on public endpoints could cause critical feedback loops, attestation verification, and settlement pipelines to freeze or drop requests.
- **Outcome**: The utility automatically instantiates and caches a standard `JsonRpcProvider` for single-RPC configurations, or an ethers `FallbackProvider` when multiple backup endpoints are provided. This resolves D-026 by securing seamless failover capability.

## 4. Local SLM Fallback for HAL Fact Checking
- **Decision**: Implemented a local keyword and heuristic fact-checking fallback layer inside `src/hal/fact-check.ts` that triggers when all external API providers fail and `HAL_LOCAL_FALLBACK_ENABLED=true` is set.
- **Context**: Complete API key exhaustion or outage of Groq/Cerebras/Fireworks would cause fact-checking to fail-closed or fail-open unpredictably.
- **Outcome**: Gracefully returns a degraded verdict marked with `fallback_used: 'local_slm'` and `confidence: 'degraded'`, preserving scoring telemetry for downstream consumption.

## 5. API Key Prioritization & Deprecation Logs
- **Decision**: Prioritize modern scoped API keys via `validateAgentApiKey` in both the agent-management (`key-management.ts`) and external scoring (`agents-external.ts`) routes.
- **Context**: Legacy keys stored under the `constitution.api_key` JSONB column must be phased out, but V1 must remain backward compatible with existing agents to prevent breaking live production integrations.
- **Outcome**: Validates modern keys first. If not found, falls back to legacy keys while logging a distinct `[DEPRECATION WARNING]`, allowing ops/telemetry to track active legacy integrations.

---

## 6. Redis Backend for Rate Limiter (D-032)
- **Decision**: Added support for a Redis-backed rate limiter controlled by the environment variable `RATE_LIMIT_BACKEND=redis` (defaults to `memory` to preserve V1 behavior).
- **Context**: In multi-instance deployments (such as Railway), using an in-memory Map for rate limiting does not scale horizontally and resets on container restarts.
- **Outcome**: Enabled horizontal scaling of rate limiting using atomic Redis token bucket operations via a Lua script. If the Redis server is unreachable, the rate limiter gracefully falls back to in-memory tracking or fails open to prevent service disruption.

## 7. Plonky3 Prover Decoupled TypeScript Wrapper (D-033)
- **Decision**: Decoupled ZKP proof generation logic into a wrapper in `src/zk-proof/prover.ts`.
- **Context**: Future V2 iterations will run full Plonky3 STARK circuits locally. Decoupling it via a TS wrapper lets the system fail over between HMAC stubs and the real Rust prover seamlessly.
- **Outcome**: Standardized the input/output shape of proof generation, ensuring zero changes are required in the `/prove-repid` router when switching prover backends in the future.


## 8. Calibration Is a Separate Portable Score, Never a RepID Input (2026-08-17)
- **Decision**: Calibration derived from committed predictions is a **separate portable score**. It is never folded into RepID, and no code path may make it a scoring input. Decided by Sean, 2026-08-17, answering the open question in `docs/RSI-ADOPTION-PLAN.md` §8.
- **Context**: The adoption plan proposes committing a prediction before a consequential action and grading the agent's self-reported confidence against the outcome (§3.1). `certainty_at_claim` is already load-bearing on the live scoring path — the production dissonance is derived entirely from it — and nothing has ever checked whether that confidence was earned. Grading it produces a genuinely new number, and the question was where that number goes.
- **Outcome**: Every RepID already issued keeps meaning exactly what it meant. RepID numbers are published, carried in badges and attestations, and written on-chain in places; folding a new term into the score would silently change the definition behind every number already in circulation, with no way for a holder to tell which definition produced theirs. A separate score also keeps the two claims independently falsifiable — "this agent behaves well" and "this agent knows what it knows" are different assertions and should fail independently. Encoded in `src/orchestration/context-frame.ts`, which defines the commitment type and deliberately defines no calibration record, so the Phase 3 gap stays visible rather than being pre-wired into scoring.
