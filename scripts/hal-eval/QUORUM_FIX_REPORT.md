# HAL quorum fix — report (S-QUORUM Phase 2)

Date: 2026-06-02 · `src/hal/fact-check.ts` · live keys (groq/cerebras/fireworks).

## TL;DR — fixed. Strictness-2 is now enforceable.

Before (S-SPINE): only 1 of 3 providers worked → quorum gate downgraded every veto to `clean` → **0 vetoes enforced** despite a good score signal. After this fix: **3 providers respond, AUC 1.00, 5/5 false claims vetoed, 0 false-positives.** Recommendation flips from WAIT → **enable `HAL_STRICTNESS=2`** (validate on a larger corpus first; mind latency).

## Root causes (from the live provider probe)

| Provider | Old config | Failure | Fix |
|---|---|---|---|
| **groq** | `llama-3.3-70b-versatile` | **HTTP 429** — free-tier RPM exhausted under any burst | model → **`llama-3.1-8b-instant`** (far higher free RPM, same clean JSON verdict) |
| **cerebras** | `llama3.1-8b` | **HTTP 404** — key has no access (only `gpt-oss-120b` + `zai-glm-4.7`) | model → **`zai-glm-4.7`**; it returns the verdict in the **`reasoning`** field (now parsed) and needs **more max_tokens** |
| **fireworks** | `kimi-k2p5` | worked but verbose chain-of-thought → first-brace parse mis-fired (called "Paris" FALSE) | parser now picks the JSON object that carries a `verdict` key, not the first brace |

## Changes (all in `src/hal/fact-check.ts`; strictness-1 prod path untouched, `HAL_STRICTNESS` still defaults 1)

1. **Models** (`buildFactCheckProviders`): groq `llama-3.1-8b-instant`, cerebras `zai-glm-4.7` (both still overridable via `HAL_S2_*_MODEL`).
2. **Content extraction** (`queryProvider`): read `content || reasoning_content || reasoning` — reasoning models (glm/gpt-oss) put output in `reasoning`.
3. **max_tokens**: default 120 → **512** — reasoning models spent the 120 budget thinking and never emitted the verdict.
4. **`parseVerdict`**: scan ALL brace-groups, prefer the one containing a `verdict` key; dropped the bare `\bTRUE\b/\bFALSE\b` keyword scan that mis-fired on reasoning prose (fallback now only matches explicit `"verdict":"…"`, else UNCERTAIN).
5. **429 backoff** (`postWith429Retry`): one jittered retry honoring `Retry-After` (≤3 s) — turns a transient free-tier 429 into a success without blowing the per-provider timeout.

## Verification — `scripts/hal-eval/strictness2-test.ts` (10-item labeled corpus, spaced)

| | mean TRUE | mean FALSE | separation | AUC | false-claims caught | false-positives |
|---|---|---|---|---|---|---|
| S1 extractor | 0.283 | 0.281 | −0.002 | **0.52** | — | — |
| **S2 fact-check (fixed)** | 0.000 | 0.963 | **0.963** | **1.00** | **5/5** | **0/5** |

Providers responding per call: **3** (occasionally 2 when cerebras' reasoning model is slow). The "Humans landed on Mars in 2019" hallucination that S1 *passed* (0.24) is now S2 **vetoed** (1.00).

## Cost & latency

- **$0** — groq/cerebras/fireworks all free-tier; trivial even on paid tiers at TrustChat volume.
- **Latency 1–12 s** per eval (3 parallel providers, slowest wins; cerebras `zai-glm-4.7` reasoning can hit ~12 s). Fine for TrustChat (low-volume, latency-tolerant); the high-throughput agent-scoring path should stay on S1.

## Recommendation

**Enable `HAL_STRICTNESS=2` for the TrustChat / leaderboard path** (set the env var in Railway; `GROQ/CEREBRAS/FIREWORKS_API_KEY` already present). Caveats:
1. Validate on a **larger labeled corpus** (this is 10 items; AUC 1.00 is encouraging but not a full eval) before trusting vetoes for high-stakes scoring.
2. Keep the **high-throughput agent path on S1** until latency is acceptable, or cap S2 concurrency.
3. If groq `8b-instant` ever rate-limits at scale, the 429 backoff + 2-of-3 quorum tolerate one provider dropping.
