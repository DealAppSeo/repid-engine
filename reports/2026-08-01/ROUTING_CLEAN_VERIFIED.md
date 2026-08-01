# LLM routing — clean on production, verified 2026-08-01 09:1x UTC

Every line measured against the deployed engine (`9ead167`), not inferred.

## Before

`POST /api/v1/llm/complete` returned **503 "Max routing attempts reached"** in 878 ms,
having burned its budget on `llama-3-2-1b` and `gemma-3-2b` — HuggingFace models the
account cannot serve. `HUGGINGFACE_API_TOKEN` is **SET** in both the reference file and on
the deployed service, so every presence-based check said fine. The key is *present and
dead*: an entitlement failure, not an auth failure.

## After

`LLM_DISABLED_PROVIDERS=llama-3-2-1b,gemma-3-2b,phi-4` (service-level, read-back verified).

One request, every provider touched, **zero failures**:

| provider | family | latency | cost |
|---|---|---|---|
| groq | Llama | 119–151 ms | $0.000011 |
| openrouter | Qwen | 134 ms | $0.000000 |
| mistral | Mistral | 573 ms | $0.000000 |
| cerebras | GLM | 776 ms | $0.000047 |
| gemini | Gemini | 1526 ms | $0.000090 |

**Total: $0.000148 per request across five independent model families.**

## Why this matters for SBFA

Divergent-family BFT needs verifiers that fail *differently*. Two instances of one model
make the same mistake and agreeing proves nothing. Five genuinely independent families are
now live in the routing path at effectively zero cost — the requirement is met, and it was
never a key-availability problem.

## What was actually wrong

Three dead providers sat at the **cheapest** tier, so the router reached them first every
time and exhausted its retry budget before touching a working one:

- `llama-3-2-1b`, `gemma-3-2b` — HuggingFace, key present, models not entitled
- `phi-4` — fails in 195 ms while `cerebras` (same key) succeeds, so a broken adapter
  rather than a credential

A **presence-based pre-filter cannot catch any of these.** Liveness is not knowable from
config, which is why the disable list is operator-stated and reversible in one env change.

## Honest notes

- `router_decision.tried` lists *candidates considered*, not HTTP attempts. Reading it as
  attempts led me to a wrong conclusion earlier; the authoritative record is `llm_call_log`.
- The first post-change smoke still showed `phi-4` failing — the redeploy had not finished.
  Confirmed clean on the following attempt. Do not read a single sample as a verdict.
- `phi-4` and the two HuggingFace models are **disabled, not fixed**. If HuggingFace
  entitlement is added later, remove them from the list and re-verify.
