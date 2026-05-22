# Agent Testing Framework

Lets Trinity-style agents exercise the MVP loop against the **deployed** repid-engine, using a **free-tier LLM** for agent reasoning so dogfooding never burns premium quota.

## Run

```bash
npx tsx scripts/agent-testing/run-all.ts            # run all scenarios
npx tsx scripts/agent-testing/run-all.ts --strict   # exit 1 if any non-skipped scenario fails (CI)
```

## Env vars

| Var | Purpose | If absent |
|---|---|---|
| `REPID_API_URL` | engine base URL | defaults to the deployed Railway URL |
| `REPID_API_KEY` | auth for write endpoints (score-event) | auth scenarios **skip** |
| `TEST_AGENT_ID` | a `repid_agents` UUID under test | hal-filter + tier-promotion **skip** |
| `TEST_PROVIDER_AGENT_ID`, `TEST_REQUESTOR_AGENT_ID` | x402 buyer/provider UUIDs | x402 scenario **skips** |
| one of `CEREBRAS_API_KEY` / `GROQ_API_KEY` / `TOGETHER_API_KEY` / `HF_API_KEY` | free LLM for agent reasoning | LLM steps fall back to a built-in prompt or note unavailability; never uses a paid provider |

Scenarios **skip (not fail)** when their preconditions are missing — so a keyless run is a clean "all skipped, with reasons" report, not a false failure.

## Scenarios

1. **x402-payment-loop** — buyer requests a tip (free LLM picks the topic); asserts the mounted x402 surface returns a 402 challenge and guards delivery until payment. (Full settlement needs a funded wallet — out of scope here.)
2. **hal-filter** — free LLM generates a confidently-false claim; submits it to `score-event`; asserts a HAL evaluation is returned.
3. **dispute-resolution** — documented **skip**: full E2E needs a seeded disputed contract + `DISPUTE_WORKER_ENABLED` + DB read (privileged seed-and-verify is a follow-up).
4. **tier-promotion** — read-only invariant: asserts the reported tier matches `compute_tier(current_repid)` (the invariant promotion relies on).

## Files

- `free-llm-router.ts` — OpenAI-compatible router; first provider whose key is set wins; bounded timeout.
- `framework.ts` — `Scenario` type, `ScenarioContext` (bounded HTTP client + `pollUntil`), `runScenario`, `computeTier`.
- `scenarios/*.ts` — the four scenarios.
- `run-all.ts` — CLI entry; prints PASS/FAIL/SKIP + summary.

## Safety

Read-leaning and safe by default: no destructive or paid action runs without explicit env opt-in; simulated x402 settlements (had they been completed) are filtered out of the on-chain writer by the FeedbackLoopWorker `is_simulated` guard, so dogfooding can never burn real gas.
