# HAL Pipeline Path Finding

This document defines the classifier path used by the deployed repid-engine (trinity-ecosystem) per request type, based on code inspection and live environment variables in Railway.

## 1. Code-Level Paths

In [src/scoring/pipeline.ts](file:///C:/Users/Cash4/repos/repid-engine-merges/src/scoring/pipeline.ts#L56-L58):
- Strictness level is resolved by `resolveHalStrictness()`, which queries `process.env.HAL_STRICTNESS`. If it is exactly `'2'`, it returns strictness level `2`; otherwise, it defaults to `1`.
- If `halStrictness >= 2` (lines 210-221), the pipeline runs the **cross-LLM fact-check quorum path** via `halService.evaluate({ text, strictness: 2 })`.
- If `halStrictness === 1` (lines 222-229), the pipeline runs the **style-extractor path** via `evaluate(answer, answer, { strictness: 1 })`.

## 2. Deployed Environment Configuration

We verified the live environment variables of the `trinity-ecosystem` service in Railway (Project: `AITrinitySymphony`, Environment: `production`):
- `HAL_STRICTNESS`: **Not set** (defaults to `1`).
- `HAL_PIPELINE_STRICTNESS`: **Not set** (defaults to `1`).
- `HAL_PENALTY_REQUIRES_QUORUM`: **Not set** (defaults to `true` / `ON` in the pipeline code).
- `HAL_DECISION_REQUIRES_QUORUM`: **Not set** (defaults to `true` / `ON` in the pipeline code).
- `HAL_DIRECT_PENALTY_REQUIRES_HALLUCINATION`: **Not set** (defaults to `true` / `ON` in the pipeline code).

### Provider Set Availability
- `GROQ_API_KEY`: Configured. Groq is active (model: `llama-3.1-8b-instant`).
- `CEREBRAS_API_KEY`: Configured. Cerebras is active (model: `zai-glm-4.7`).
- `DEEPSEEK_API_KEY`: Configured. `HAL_S2_ENABLE_DEEPSEEK` is explicitly set to `true`, so DeepSeek is active.
- `FIREWORKS_API_KEY`: Configured, but `HAL_S2_ENABLE_FIREWORKS` is not set, so Fireworks is disabled.
- `GEMINI_API_KEY`: Configured, but `HAL_S2_ENABLE_GEMINI` is not set, so Gemini is disabled.

## 3. Deployed Request Routing Verdict

For a normal `SERVICE_FULFILLED` / prompt route, the live engine resolves `resolveHalStrictness()` to **`1`**.
Therefore, **the live deployed engine currently runs on the style-extractor (strictness 1) path**, which has been proven in prior audits to have zero discriminative power (AUC ~0.375, below chance). The strong cross-LLM fact-check path (strictness 2) exists in code but is inactive.
