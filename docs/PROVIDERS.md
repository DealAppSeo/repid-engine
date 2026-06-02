# LLM Providers (repid-engine)

How repid-engine routes LLM calls and which providers are configured. Verified `[railway:2026-06-02]` against the prod `repid-engine` service.

## Routing model
- **`POST /api/v1/llm/complete`** is **ANFIS/tier-routed**, not provider-forced. The body takes `tier_preference` (`auto` default), `task_hint`, and `user_paid_keys` (BYOK). `routeRequest()` picks the best provider within the tier by fitness (hit-rate · latency · cost), trying cheap tier-0 before paid tier-1, with health-based failover. `GET /api/v1/llm/providers` lists the registry + health.
- **`GET /api/v1/llm/providers`** — current adapters + health states.
- **TrustChat `POST /chat`** (trustchat-backend) **already accepts provider selection** via `byok_provider` + `model_preference` (→ `callLitellm(message, model_preference)`), and records `llm_provider_used` in `trustchat_sessions`. So the "user can pick a provider" requirement is met at the chat layer.

## Provider matrix (tier-0 adapters; prod key status verified)
| Provider | Adapter | API key env var | Prod key present | Status |
|---|---|---|---|---|
| Groq | `src/providers/groq.ts` | `GROQ_API_KEY` | ✅ | Working (HAL cross-LLM #1, `llama-3.3-70b-versatile`) |
| Anthropic | `src/providers/anthropic.ts` | `ANTHROPIC_API_KEY` | ✅ | Working (chat default `anthropic-direct`; cross-LLM `claude-haiku-4-5-20251001`) |
| Cerebras | `src/providers/cerebras.ts` | `CEREBRAS_API_KEY` | ✅ | Working (HAL strictness-2 quorum, `llama3.1-8b`) |
| Fireworks | (HAL fact-check) | `FIREWORKS_API_KEY` | ✅ | Working (HAL strictness-2 quorum) |
| DeepSeek | `src/providers/deepseek.ts` | `DEEPSEEK_API_KEY` | ✅ | Working (`deepseek-chat`) |
| Gemini | `src/providers/gemini.ts` | `GEMINI_API_KEY` | ✅ | Working |
| OpenAI | `src/providers/openai.ts` | `OPENAI_API_KEY` | ✅ | Working (tier-1 / user-paid) |
| Cohere | `src/providers/cohere.ts` | `COHERE_API_KEY` | ✅ | Working |
| HuggingFace SLMs | `src/providers/slm.ts` | `HUGGINGFACE_API_TOKEN` / `HF_TOKEN` | ✅ | SLM tier (`llama-3-2-1b`, `gemma-3-2b`) |

**All configured provider keys are present on prod** — no missing keys. (`GOOGLE_API_KEY` is referenced as a fallback but `GEMINI_API_KEY` is the one set.)

> ⚠️ Several of these keys appear in S-MVP2's public secret-scanning alerts (git history of `trinity-symphony-shared`). Rotate per `CC_S-MVP2_RESULTS.md` before relying on them long-term.

## HAL cross-LLM (strictness-2) quorum
The discriminative fact-check (`buildFactCheckProviders`) uses **GROQ + CEREBRAS + FIREWORKS** (each added only if its key is present). All three are present → 3-provider quorum can form. Note: it is provider-fragile under burst load (see `scripts/hal-eval/CALIBRATION_REPORT.md`).

## Adding a new provider
1. Add `src/providers/<name>.ts` exporting an adapter (`name`, `tier`, `complete()`), reading `process.env.<NAME>_API_KEY`.
2. Register it in `src/providers/router.ts` (and `slm-tier.ts` if SLM).
3. Add the key to Railway (`repid-engine` service) — never commit it.
4. (HAL fact-check) add it to `buildFactCheckProviders` in `src/hal/fact-check.ts` if it should join the quorum.
5. `npx tsc --noEmit` 0, add a test, update this table.
