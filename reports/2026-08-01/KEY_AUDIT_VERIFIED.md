# Verified key report — 2026-08-01
**Method:** every credential below was **probed** — an actual authenticated call to the provider. Nothing here is inferred from "the variable is set". Where a probe could not conclude, it says so instead of guessing.

Run with `trustkeys audit`, which compares the reference file against the deployed value AND probes both.

## DEAD — 3, confirmed by failed authentication

| variable | state |
|---|---|
| `ELEVENLABS_API_KEY` | same value in reference and deployed, **both DEAD** |
| `SILICONFLOW_API_KEY` | same value in reference and deployed, **both DEAD** |
| `TELEGRAM_BOT_TOKEN` | same value in reference and deployed, **both DEAD** |

**None of these is in the LLM routing path.** Rotating them does not affect SBFA, HAL, or ANFIS. Telegram matters only for HITL alerts.

## LIVE — 15, authenticated successfully

`ANTHROPIC_API_KEY` · `CEREBRAS_API_KEY` · `COHERE_API_KEY` · `DATABASE_URL` · `DEEPINFRA_API_KEY` · `DEEPSEEK_API_KEY` · `GEMINI_API_KEY` · `GITHUB_TOKEN` · `GROK_API_KEY` · `GROQ_API_KEY` · `MISTRAL_API_KEY` · `RESEND_API_KEY` · `SAMBANOVA_API_KEY` · `STABILITY_API_KEY` · `TOGETHER_API_KEY`

## LIVE BUT DRIFTED — 5, both values valid

`OPENAI_API_KEY` · `OPENROUTER_API_KEY` · `SUPABASE_SECRET_KEY` · `SUPABASE_SERVICE_KEY` · `SUPABASE_SERVICE_ROLE_KEY`

Reference and deployed hold **different** values and **both authenticate**. Harmless today; pick a canonical one so a future rotation doesn't leave half the fleet on an orphan.

## UNRESOLVED — 2, NOT dead

| variable | why |
|---|---|
| `FIREWORKS_API_KEY` | probe `INCONCLUSIVE` — rate-limited or 5xx |
| `PERPLEXITY_API_KEY` | probe `INCONCLUSIVE` |

**Do not rotate these on this evidence.** An inconclusive probe is not a dead key. Re-run the audit when the provider is not rate-limiting.

## 🔴 THE ONE THAT ACTUALLY BROKE ROUTING — and the audit missed it

`HUGGINGFACE_API_TOKEN` is **SET** in `.env.master` and **SET** on the deployed `repid-engine` service. Every presence check says fine. HuggingFace answers:

> `400 — The requested model 'meta-llama/Llama-3.2-1B-Instruct' is not supported by any provider you have enabled.`

**The key is present and dead.** It is not an auth failure, it is an entitlement failure, which is why nothing flagged it.

It appears in the **skipped (no probe available)** list above — TrustKeys has no HuggingFace prober, so the one credential that was actually breaking the LLM broker is precisely the one the audit could not see. That is threat-model gap **W2** ("probe coverage is uneven; absence of a probe is not absence of risk") biting exactly where it hurt.

**Action:** add a HuggingFace prober to TrustKeys, and keep `llama-3-2-1b` / `gemma-3-2b` out of routing until it probes LIVE.

## What this means for SBFA divergent-family BFT

You said the divergent-family requirement is what matters. It is already satisfiable — **no rotation needed**:

| family | provider | verified |
|---|---|---|
| Llama | Groq | LIVE |
| DeepSeek | DeepSeek | LIVE |
| Gemini | Google | LIVE |
| Mistral | Mistral | LIVE |
| Qwen / GLM | Cerebras, Together, SambaNova, DeepInfra | LIVE |
| Command | Cohere | LIVE |
| Grok | xAI | LIVE |
| Claude / GPT | Anthropic, OpenAI | LIVE (paid) |
| *many* | OpenRouter | LIVE (gateway) |

That is **7+ genuinely independent model families on free or near-free tiers**, all verified by authentication tonight. SBFA has no shortage of divergent families. The blocker was never key availability — it was that the router's cheapest tier pointed at a HuggingFace model the account cannot serve, and burned its retry budget there.
