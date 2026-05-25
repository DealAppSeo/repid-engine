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

## 3. Multi-RPC Failover Utility
- **Decision**: Created `src/clients/rpc-with-failover.ts` and integrated it across all components that perform on-chain operations (`x402-facilitator`, `x402-outbound-client`, `repid-attestation`, and `erc8004-reputation`).
- **Context**: In V1 production, RPC outages on public endpoints could cause critical feedback loops, attestation verification, and settlement pipelines to freeze or drop requests.
- **Outcome**: The utility automatically instantiates and caches a standard `JsonRpcProvider` for single-RPC configurations, or an ethers `FallbackProvider` when multiple backup endpoints are provided.

## 4. Local SLM Fallback for HAL Fact Checking
- **Decision**: Implemented a local keyword and heuristic fact-checking fallback layer inside `src/hal/fact-check.ts` that triggers when all external API providers fail and `HAL_LOCAL_FALLBACK_ENABLED=true` is set.
- **Context**: Complete API key exhaustion or outage of Groq/Cerebras/Fireworks would cause fact-checking to fail-closed or fail-open unpredictably.
- **Outcome**: Gracefully returns a degraded verdict marked with `fallback_used: 'local_slm'` and `confidence: 'degraded'`, preserving scoring telemetry for downstream consumption.

## 5. API Key Prioritization & Deprecation Logs
- **Decision**: Prioritize modern scoped API keys via `validateAgentApiKey` in both the agent-management (`key-management.ts`) and external scoring (`agents-external.ts`) routes.
- **Context**: Legacy keys stored under the `constitution.api_key` JSONB column must be phased out, but V1 must remain backward compatible with existing agents to prevent breaking live production integrations.
- **Outcome**: Validates modern keys first. If not found, falls back to legacy keys while logging a distinct `[DEPRECATION WARNING]`, allowing ops/telemetry to track active legacy integrations.
