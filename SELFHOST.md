# Self-host / data-local (skeleton)

Engineering status of running repid-engine so **prompt/response text stays on
your box**. This is a skeleton: it states exactly what boots today and what is
still hosted-only. No marketing claims.

## What the audit found (the two egress paths)

1. **Boot coupling.** `src/config.ts` throws at import when `SUPABASE_URL` / a
   service key is absent, so a clone with no hosted Supabase cannot even start.
2. **Prompt egress.** The HAL quorum POSTs prompt text to cloud LLM APIs
   (`api.groq.com`, `api.deepseek.com`, `api.anthropic.com`, …).

This change adds three env-guarded seams that address both, all **default-OFF**
(hosted behavior is byte-for-byte unchanged when the flags are unset).

## Env flags

| Env | Default | Effect |
|-----|---------|--------|
| `LOCAL_MODE` | off | Boot without a hosted Supabase. A missing `SUPABASE_URL`/key is backfilled with the loopback default `http://127.0.0.1:54321` instead of throwing. Announced loudly at boot. |
| `ONLY_ATTESTATIONS_LEAVE` | off | Data-locality boundary. Prompt/response **text** may not egress to a non-local host; proofs / EAS anchors / chain RPC still may. Enforced at the HAL provider call choke point (`src/hal/cross-llm-client.ts` → `assertPromptEgressAllowed`). |
| `LOCAL_LLM_BASE_URL` (or `OPENAI_BASE_URL`) | unset | OpenAI-compatible base URL for the quorum. Redirects every `openai-compat` provider to `<base>/chat/completions` — e.g. an Ollama (`http://localhost:11434/v1`) or vLLM box. `anthropic-native` is never redirected (wrong wire shape). |

"Local" for the boundary = loopback, RFC1918/private LAN, link-local, and the
`host.docker.internal` / `ollama` / `vllm` service conventions
(`src/selfhost/egress-guard.ts`).

## What BOOTS today (REAL, verified)

- **The data-local core process** — `src/selfhost.ts`, entry `dist/selfhost.js`.
  Boots with **no hosted Supabase**, binds `0.0.0.0:$PORT`, serves:
  - `GET /health` — liveness + whether a hosted DB is configured.
  - `GET /selfhost/status` — the boundary it is running under, plus an explicit
    `boots_today` vs `stub_for_selfhost` split.
- **Config loads without hosted Supabase** under `LOCAL_MODE` (was a hard throw).
- **The egress boundary** — with `ONLY_ATTESTATIONS_LEAVE=true`, a prompt bound
  for a cloud LLM is refused before it is sent; a local target and all
  commitments (attestation/chain) pass.
- **The LLM base-URL override** — the quorum's openai-compat providers retarget
  to a local model with one env var.

Verified boot (LOCAL_MODE, no `SUPABASE_URL`, boundary on, local model base):

```
[LOCAL_MODE] enabled — data-local boot. supabase=LOOPBACK http://127.0.0.1:54321 (no hosted DB) · ONLY_ATTESTATIONS_LEAVE=true · LOCAL_LLM_BASE_URL=http://localhost:11434/v1
[selfhost] repid-engine v1.0.0 data-local boot on :39217
  local_mode=true hosted_db=false
  only_attestations_leave=true prompt_egress_to_cloud=blocked
  llm_quorum_target=local local_base_url=http://localhost:11434/v1
```

Covered by tests under `tests/selfhost-*.test.ts` (38 assertions, offline).

## What is STILL hosted-only (STUB for self-host)

- **The RepID score-mutation pipeline** (`src/engine/repid-update.ts`) and the
  full `src/index.ts` entrypoint. `index.ts` starts ~20 background workers/crons
  that read/write the hosted Supabase over the network. `LOCAL_MODE` stops the
  *throw*, but those workers are **not** yet backed by a local store, so running
  `dist/index.js` in LOCAL_MODE would spin errors against a loopback DB. The
  self-host entry deliberately does **not** start them.
- **A local persistent store adapter** (SQLite / local-Postgres) implementing the
  handful of tables the engine actually uses (`repid_agents`,
  `repid_score_events`, …). Not built. This is the next slice: a `db`-shaped
  adapter selected by `LOCAL_MODE`, so `updateRepId()` and friends run locally.
- **The embedding call** in the HAL agreement step also egresses text
  (`api.openai.com/v1/embeddings`). The guard classifies `embedding` as
  content-bearing, but the embedding client is not yet wired through
  `assertPromptEgressAllowed`; under the boundary the quorum falls back to local
  Jaccard similarity, so it degrades rather than leaks — but the explicit guard
  at that call site is still TODO.

## Run it

Local process:

```bash
npm run build
LOCAL_MODE=true ONLY_ATTESTATIONS_LEAVE=true \
  LOCAL_LLM_BASE_URL=http://localhost:11434/v1 \
  node dist/selfhost.js
curl localhost:3000/selfhost/status
```

Container (`Dockerfile.selfhost` bakes `LOCAL_MODE`/`ONLY_ATTESTATIONS_LEAVE` on):

```bash
DOCKER_BUILDKIT=1 docker build -f Dockerfile.selfhost \
  --secret id=gh_token,env=GH_TOKEN -t repid-engine:selfhost .
docker run --rm -p 3000:3000 \
  -e LOCAL_LLM_BASE_URL=http://host.docker.internal:11434/v1 \
  repid-engine:selfhost
```

(The `gh_token` build secret is only needed while `@hyperdag/proof-verifier`
resolves from a private GitHub repo.)
