# LLM Providers (repid-engine)

How repid-engine routes LLM calls and which providers are configured. Verified `[railway:2026-06-02]` against the prod `repid-engine` service.

## Routing model
- **`POST /api/v1/llm/complete`** is **ANFIS/tier-routed**, not provider-forced. The body takes `tier_preference` (`auto` default), `task_hint`, and `user_paid_keys` (BYOK). `routeRequest()` picks the best provider within the tier by fitness (hit-rate · latency · cost), trying cheap tier-0 before paid tier-1, with health-based failover. `GET /api/v1/llm/providers` lists the registry + health.
- **`GET /api/v1/llm/providers`** — current adapters + health states.
- **TrustChat `POST /chat`** (trustchat-backend) **already accepts provider selection** via `byok_provider` + `model_preference` (→ `callLitellm(message, model_preference)`), and records `llm_provider_used` in `trustchat_sessions`. So the "user can pick a provider" requirement is met at the chat layer.

## Provider matrix (tier-0 adapters; prod key status verified)
| Provider | Adapter | API key env var | Prod key present | Status |
|---|---|---|---|---|
| Groq | `src/providers/groq.ts` | `GROQ_API_KEY` | ✅ | Working (HAL cross-LLM #1, `llama-3.1-8b-instant`) |
| Anthropic | `src/providers/anthropic.ts` | `ANTHROPIC_API_KEY` | ✅ | Working (chat default `anthropic-direct`; cross-LLM `claude-haiku-4-5-20251001`) |
| Cerebras | `src/providers/cerebras.ts` | `CEREBRAS_API_KEY` | ✅ | Working (HAL strictness-2 quorum, `zai-glm-4.7`) |
| Fireworks | (HAL fact-check) | `FIREWORKS_API_KEY` | ✅ | Working (HAL strictness-2 quorum) |
| DeepSeek | `src/providers/deepseek.ts` | `DEEPSEEK_API_KEY` | ✅ | Working (`deepseek-chat`) |
| Gemini | `src/providers/gemini.ts` | `GEMINI_API_KEY` | ✅ | Working |
| OpenAI | `src/providers/openai.ts` | `OPENAI_API_KEY` | ✅ | Working (tier-1 / user-paid) |
| Cohere | `src/providers/cohere.ts` | `COHERE_API_KEY` | ✅ | Working |
| HuggingFace SLMs | `src/providers/slm.ts` | `HUGGINGFACE_API_TOKEN` / `HF_TOKEN` | ✅ | SLM tier (`llama-3-2-1b`, `gemma-3-2b`) |

**All configured provider keys are present on prod** — no missing keys. (`GOOGLE_API_KEY` is referenced as a fallback but `GEMINI_API_KEY` is the one set.)

> ⚠️ Several of these keys appear in S-MVP2's public secret-scanning alerts (git history of `trinity-symphony-shared`). Rotate per `CC_S-MVP2_RESULTS.md` before relying on them long-term.

## HAL cross-LLM (strictness-2) quorum

The discriminative fact-check (`buildFactCheckProviders` in `src/hal/fact-check.ts`) uses **GROQ + CEREBRAS + FIREWORKS** (each added only if its key is present); a veto requires ≥2 of them to respond (`MIN_QUORUM_FOR_VETO`).

**S-QUORUM fix (2026-06-02)** — the quorum was broken (only 1/3 worked → no enforceable vetoes). Now fixed; live AUC went **0.52 → 1.00**, 5/5 false claims vetoed. See `scripts/hal-eval/QUORUM_FIX_REPORT.md`.

| Provider | Model (default; `HAL_S2_*_MODEL` overrides) | Status | Notes |
|---|---|---|---|
| **groq** | `llama-3.1-8b-instant` | ✅ working | was `llama-3.3-70b-versatile` → **429** on free tier under burst; 8b-instant has a far higher free RPM |
| **cerebras** | `zai-glm-4.7` | ✅ working | was `llama3.1-8b` → **404** (no access on this key); glm returns the verdict in the `reasoning` field (now parsed) and needs `max_tokens ≥ 512` |
| **fireworks** | `kimi-k2p5` | ✅ working | verbose reasoning model; `parseVerdict` now picks the JSON object carrying a `verdict` key (not the first brace) |

Hardening also added: `content || reasoning_content || reasoning` extraction, a single jittered **429 backoff** (`postWith429Retry`), and `max_tokens 120 → 512`. **Latency 1–12 s/eval** (3 parallel; slowest wins) — fine for TrustChat, keep high-throughput agent scoring on strictness-1. To enable: set `HAL_STRICTNESS=2` in Railway (validate on a larger corpus first).

**To add a quorum provider:** it must return a parseable JSON `{"verdict","confidence"}` in `content` *or* a `reasoning`/`reasoning_content` field; pick a model that isn't so verbose it never reaches the JSON within `max_tokens`.

## Adding a new provider
1. Add `src/providers/<name>.ts` exporting an adapter (`name`, `tier`, `complete()`), reading `process.env.<NAME>_API_KEY`.
2. Register it in `src/providers/router.ts` (and `slm-tier.ts` if SLM).
3. Add the key to Railway (`repid-engine` service) — never commit it.
4. (HAL fact-check) add it to `buildFactCheckProviders` in `src/hal/fact-check.ts` if it should join the quorum.
5. `npx tsc --noEmit` 0, add a test, update this table.
