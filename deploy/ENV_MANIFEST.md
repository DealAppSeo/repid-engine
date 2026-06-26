# ENV_MANIFEST — repid-engine portable env-var KEY surface
PREP doc · 2026-06-26 · XC lane · **KEY NAMES ONLY — ZERO VALUES / ZERO SECRETS**

Purpose: so a standby host (Fly / Coolify) can be provisioned with the **same** env surface as Railway,
the manifest enumerates the env-var **names** repid-engine needs, grouped by surface, with each marked
SECRET or non-secret. Values live ONLY in host secret stores (Railway env, Fly secrets, GH Actions
secrets) — never in this repo. (Reinforces INFRA_INVENTORY §11 secrets-hygiene: the plaintext
`litellm_vars.txt` / `railway_env.json` / `railway_vars_full.txt` on disk are the exposure to avoid.)

## HOW THIS WAS DERIVED
- **BOOT-REQUIRED + core**: read directly from `src/config.ts` + `src/index.ts` + repo `CLAUDE.md` [V].
- **ACTIVE-PATH (providers/crypto/feature flags)**: from INFRA_INVENTORY §11 (repid-engine = 99-key
  Railway surface) [reported] — treat as the superset; the standby only needs the keys the active code
  paths use. The authoritative live diff is the [SEAN] command below (names only, never printed values).

## [SEAN] — reproduce the exact set without printing secret values
```
# names only — pipe to keys, never echo values
railway variables --json | jq 'keys'                 # Railway repid-engine service
flyctl secrets list                                  # Fly standby (shows names + digests, NOT values)
# diff the two key-sets; any name in Railway-not-in-Fly must be `flyctl secrets set NAME=...`  [SEAN]
```

---

## 1) REQUIRED AT BOOT — process throws without these (`src/config.ts:18-19`)
| Key | Secret? | Notes |
|---|---|---|
| `SUPABASE_URL` | no (URL, but treat as config) | Trinity prod project URL. Boot throws if missing. |
| `SUPABASE_SERVICE_KEY` **or** `SUPABASE_SERVICE_ROLE_KEY` | **SECRET** | config reads `SUPABASE_SERVICE_ROLE_KEY \|\| SUPABASE_SERVICE_KEY`. Set at least one; service-role key bypasses RLS (that's intended for the engine). Boot throws if neither present. |

> Standby is useless until these are mirrored to Fly secrets. The `/health` route does a live Supabase
> read, so a green Fly health check also proves these creds work on the standby.

## 2) CORE RUNTIME (have safe defaults, but set for parity)
| Key | Secret? | Default if unset |
|---|---|---|
| `PORT` | no | `3000` — host (Railway/Fly) injects this; do not hardcode. |
| `NODE_ENV` | no | `development` → set `production` on standby (fly.toml does). |
| `REPID_ENGINE_VERSION` | no | `1.0.0` |

## 3) AUTH / API SURFACE
| Key | Secret? | Notes |
|---|---|---|
| `REPID_API_KEYS` | **SECRET** | comma-separated `key:tier` pairs (`secret:pro,corp:enterprise`). authMiddleware validates Bearer/x-api-key against this. Standby MUST share the SAME set as Railway so existing client keys keep working after a flip. |

## 4) DATABASE DIRECT (hot-path pg pooler, if used by deployed code)
| Key | Secret? | Notes |
|---|---|---|
| `DATABASE_URL` | **SECRET** | Supabase pooler connection string (`:6543`). Used by direct-pg hot paths / proof-drain worker. |

## 5) ON-CHAIN / CRYPTO (active-path; required only if the standby runs the on-chain writers — for a
read-mostly warm standby these can be omitted until the loop is activated post-CC-fix)
| Key | Secret? | Notes |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | **SECRET** | optional in config; read paths work without it, writes need it. |
| `ERC8004_OPERATOR_KEY` | **SECRET** | ERC-8004 operator. |
| `ERC8004_REPUTATION_WRITER_KEY` | **SECRET** | funded reputation writer key. |
| `BASE_SEPOLIA_PRIVATE_KEY` | **SECRET** | Base Sepolia signer. |
| `BASE_SEPOLIA_RPC_URL` | no | RPC endpoint (config, not secret). |
| `EAS_ATTESTER_PRIVATE_KEY` | **SECRET** | EAS attester (must derive to the funded attester address). |
| `HYPERDAG_ATTESTOR_PRIVATE_KEY` | **SECRET** | funded attester (per STATE_OF_THE_SYSTEM EAS note). |
| `HASHKEY_RPC_URL` / `HSK_CHAIN_ID` / `HSK_CONTRACT_ADDRESS` | no | HashKey testnet config (have defaults). |

## 6) LLM PROVIDER KEYS (active-path — HAL quorum calls providers DIRECT, not via LiteLLM, per memory)
All **SECRET**. Set the ones the deployed HAL/ANFIS code actually calls; the full Railway superset is ~99
keys. Representative names (from INFRA_INVENTORY §11):
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `DEEPSEEK_API_KEY`,
`GEMINI_API_KEY`, `GROK_API_KEY` (xAI), `MISTRAL_API_KEY`, `FIREWORKS_API_KEY`, `COHERE_API_KEY`,
`TOGETHER_API_KEY`, `OPENROUTER_API_KEY`, `PERPLEXITY_API_KEY`, `PORTKEY_API_KEY`, `ASI1_API_KEY`,
`HUGGINGFACE_API_KEY` (+ any `*_API_KEY` the live HAL provider list resolves).

## 7) HAL / FEATURE FLAGS (non-secret; control behavior — MUST match Railway for identical behavior)
| Key | Secret? | Notes |
|---|---|---|
| `HAL_PIPELINE_STRICTNESS` | no | dedicated knob, default 2 pre-launch (THE_ONE R7 / D-031rev). Log loudly at boot. |
| `HAL_STRICTNESS` | no | shared knob (decoupled from the dedicated one above). |
| `HAL_ENRICHMENT_ENABLED` | no | gate; default OFF. |
| `HAL_PENALTY_REQUIRES_QUORUM` | no | default ON (fail-safe; needs ≥2 providers). |
| `HAL_S2_ENABLE_*` | no | per-provider strictness-2 enable flags (memory: prod HAL quorum gate). |
| `ESCALATION_CONTRACT` | no | service-contract poll gate. **Keep OFF on standby until activation** (loop revival is Sean-only). |
| `CASCADE_SETTLEMENT_ENABLED` | no | cascade settlement worker gate. |
| `DISPUTE_WORKER_ENABLED` | no | dispute consumer gate. |
| `TOOL_CALL_LOGGING` | no | logging flag (present on Railway). |

## 8) MISC INTEGRATIONS (set only if the deployed standby code path uses them)
`TELEGRAM_*` (alerts), `PINATA_*` (IPFS), `CLOUDFLARE_*`, `DRAGONFLY_*` / Redis (`ioredis`), `STRIPE_*`,
`ALPACA_*` / `COINBASE_*` (trading) — all **SECRET**. A read-mostly warm standby can omit these until the
full loop is activated.

---

## COMPLETENESS GATE
- ✅ 100% of **boot-required** keys (§1) enumerated from `config.ts` [V].
- ✅ Active-path keys (§3–7) enumerated from CLAUDE.md + INFRA_INVENTORY §11.
- ✅ ZERO secret values in this file.
- ⚠ §6/§8 are the Railway superset; the standby needs only the subset the deployed code resolves at
  runtime — the [SEAN] `railway variables --json | jq 'keys'` diff is the authoritative reconcile.

*Names not values. Secrets live in host stores. Micah 6:8.*
