# HAL strictness-2 — live verification + activation recommendation (S-SPINE Phase 2)

Date: 2026-06-02 · live keys (groq/cerebras/fireworks from crosscheck `.env`) · `scripts/hal-eval/strictness2-test.ts`.

## Verdict (one line)

**Do NOT flip `HAL_STRICTNESS=2` globally yet.** The fact-check *score signal is strong* (AUC **0.82**, matching the labeled-corpus 0.79), but the quorum is **operationally broken** — only **1 of 3 providers** returns a parseable verdict, and the resilience gate (correctly) refuses to veto on a lone provider, so **S2 enforces 0 vetoes today**.

## Evidence — S1 vs S2 on a 10-claim labeled corpus

| Run | mean TRUE | mean FALSE | separation | AUC |
|---|---|---|---|---|
| **S1 extractor** | 0.283 | 0.281 | **−0.002** | **0.52** (blind, coin-flip) |
| **S2 fact-check, burst** (no spacing) | 0.560 | 0.620 | 0.060 | 0.56 (collapses — providers 429) |
| **S2 fact-check, spaced 4s** | 0.500 | 0.740 | **0.240** | **0.82** (strong) |

`hal_score` is RISK (high = false/hallucinated). The spaced S2 run cleanly separates true (0.50) from false (0.74) claims. **But** `S2 caught 0/5 false claims at the DECISION level** — every case ran with only 1 surviving provider, and the quorum gate downgrades a lone-provider veto/flag to `clean`.

## Root cause — provider health probe (`_provider_probe.ts`)

For one claim, all three providers were attempted; `succeeded: 1/3`:

| Provider | Model (default) | Result |
|---|---|---|
| **groq** | `llama-3.3-70b-versatile` | **HTTP 429** — free-tier rate limit; dies under any burst/concurrency |
| **cerebras** | `llama3.1-8b` | **HTTP 404 — "Model does not exist or you do not have access"**. This key only exposes `gpt-oss-120b` + `zai-glm-4.7`, both **reasoning models that return an empty `content`/`reasoning_content`** (output lands in a `reasoning` field the fact-check parser doesn't read) → **unusable with this key regardless of model ID** |
| **fireworks** | `accounts/fireworks/models/kimi-k2p5` | ✅ responds with content — but mis-verdicted "The capital of France is Paris" as FALSE (model/parse accuracy imperfect) |

So the effective quorum is **fireworks alone** (+ groq only when un-throttled). `MIN_QUORUM_FOR_VETO` ≥ 2, so with 1 provider every decision is forced to `clean`. The system is behaving *correctly* given its inputs — the inputs (provider health) are the problem.

## Cost analysis

- **Dollar cost ≈ $0.** groq / cerebras / fireworks are all on **free tiers**. At 100 evals/day the marginal $ cost is negligible even on paid tiers (each eval ≈ a few hundred tokens × 3 providers; well under $1/day).
- **The real cost is latency + reliability**, not money: each S2 eval is **~2–8 s** (3 parallel provider calls, slowest wins) vs the S1 extractor's **~2 ms** (local, synchronous). And free-tier groq **429s under burst**, which is what makes the quorum collapse.

## Recommendation

1. **Keep `HAL_STRICTNESS=1` as the default for now** (no global flip). S2's enforcement is currently vacuous (0 vetoes) because of the quorum, so flipping it would add 2–8 s latency for no safety gain.
2. **Fix the quorum to ≥2 reliably-parseable providers before enabling**, in priority order:
   - **cerebras**: get a key with `llama-3.x` access, **or** add a `reasoning`-field fallback to `queryProvider` so glm/gpt-oss reasoning models parse. (Today: dead.)
   - **groq**: move off the free tier *or* add a second groq-class provider so a 429 doesn't drop the quorum below 2.
   - Re-run `strictness2-test.ts` spaced → confirm ≥2 providers succeed and the **0.82 AUC becomes *enforceable*** (vetoes actually fire).
3. **Then enable as a hybrid, not blanket**: S1 is blind *and* over-vetoes (it flagged nearly every true claim in this run), so "S1 screen → S2 confirm" doesn't help. Better target: route **TrustChat** evaluations through S2 directly (low volume, latency-tolerant, this is the public trust surface) while leaving the high-throughput agent-scoring path on S1 until the quorum is hardened. Env change when ready: `HAL_STRICTNESS=2` (+ ensure `GROQ/CEREBRAS/FIREWORKS_API_KEY` set in Railway).
4. **No code change made to the HAL path this sprint** — this is verification only; the flag stays default-off. The two concrete fixes (cerebras model/parsing, groq tier) are handed to Sean/Cowork.
