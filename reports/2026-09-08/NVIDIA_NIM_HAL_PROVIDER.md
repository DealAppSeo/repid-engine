# NVIDIA NIM as a HAL fact-check provider — default OFF

Branch `feat/cc-2026-09-08-nvidia-nim-hal-provider`, off `main` (after the 11 merges).
Internal tier (LESSONS/CLAUDE.md), per the two-tier rule: this is HAL provider
machinery, not a published builder contract — `hyperdag-protocol/BUILDERS.md` is
untouched and does not enumerate the quorum's providers.

Outcomes are reported three ways: **VERIFIED** / **NOT CHECKED** / **FAILED**.

## What shipped

- `src/hal/fact-check.ts` — `nvidia-nim` added to `buildFactCheckProvidersWith`
  as an **openai-compat** provider reading `NVIDIA_NIM_API_KEY` (with a
`NIM_API_KEY` fallback — see the key-name finding), endpoint
  `https://integrate.api.nvidia.com/v1/chat/completions`, family declared
  `nvidia`, tier `escalation`; model `HAL_S2_NVIDIA_NIM_MODEL` (default
  `nvidia/nemotron-4-340b-instruct`, **documentation-sourced, see NOT CHECKED**).
  Enabled only by `enabled.nvidiaNim` with **no `|| ab`** — opt-in, never
  auto-backfilled.
- `src/hal/config.ts` — `HAL_S2_ENABLE_NVIDIA_NIM` added to the resolved
  provider keys, `PROVIDER_DEFAULTS` = **false**.
- `src/config/known-env-vars.generated.ts` — **regenerated** via
  `npm run gen:env-registry` (not hand-edited). It captured `NVIDIA_NIM_API_KEY`
  and `HAL_S2_ENABLE_NVIDIA_NIM`. `HAL_S2_NVIDIA_NIM_MODEL` is read via the
  `add()` helper's `process.env[envVar]` indirection, which the static generator
  cannot see — exactly like every sibling `HAL_S2_*_MODEL` override (ZAI/MISTRAL/
  DEEPSEEK), none of which are registered either. The named-env-var guard does
  not flag it (a `_MODEL` suffix is not env-shaped to the matcher), so no
  allowlist entry is needed; adding one would fail the guard's unused-entry check.

I did not create, read, or handle a key value. Sean's key stays in `.env.master`,
unseen.

### Key-name finding — REUSE, not create [VERIFIED, names only]

The task specified `NVIDIA_NIM_API_KEY`, but the credential already saved in
`.env.master` (127 keys; I read names only, never values) is named **`NIM_API_KEY`**
— `NVIDIA_NIM_API_KEY` is not present. Had the code read only the canonical name,
the provider would have been silently keyless: a provider that always fails looks
identical to one never configured (the exact trap the repo's skip/health plumbing
exists to prevent). So `add()` reads **`NVIDIA_NIM_API_KEY ?? NIM_API_KEY`** —
canonical name first, the already-saved key as fallback. No new secret is created.
Sean's choice: rename to the canonical `NVIDIA_NIM_API_KEY`, or leave `NIM_API_KEY`
as the working fallback. Both env names are in the regenerated registry.

> **RESOLVED 2026-09-09 — renamed to canonical.** The operator renamed the variable in
> `.env.master`; the file now holds exactly one NIM variable and it is
> **`NVIDIA_NIM_API_KEY`** [MEASURED, names only — the rename script printed variable
> names and never a value]. So the paragraph above is now a record of what was true on
> 2026-09-08, not a description of the current machine, and the `NIM_API_KEY` fallback is
> no longer the path that fires there.
>
> **The fallback stays in code, deliberately.** It is now a compatibility shim rather than
> the primary read. Whether Railway carries either name is **NOT CHECKED** — nothing in
> this session read that service's Variables, and one machine's env file is not evidence
> about a deployment. Deleting the shim is a deployment decision, not a cleanup.
>
> This note exists because the finding above states the saved name as a present-tense
> fact. A dated measurement that reads as a standing fact is exactly what sends the next
> agent looking for a variable that is no longer there.

## Default OFF, and off means byte-identical — VERIFIED

`tests/hal-nvidia-nim-provider.test.ts` (6 tests, all pass):
- flag unset + key present ⇒ NIM **absent**, and the provider list is identical
  to the no-key case (the safety claim: a bare key never widens the quorum).
- flag on + no key ⇒ absent (nothing to dial).
- flag on + key ⇒ present, family `nvidia`, correct endpoint, openai dialect.
- `HAL_S2_NVIDIA_NIM_MODEL` override honoured.
- `getHalConfig().providers.HAL_S2_ENABLE_NVIDIA_NIM` resolves **false** by default.

`tsc --noEmit` clean. `tests/hal/fact-check.test.ts` + `tests/hal-family-quorum.test.ts`
pass unchanged (33 total with the new file) — no regression to the existing quorum.

## Quorum effect — measured where possible, NOT CHECKED where it needs the key

Cross-LLM consensus is load-bearing, so this is the gate on recommending it ON.

**VERIFIED (no key needed):**
- **Off is inert** (above): the quorum a reviewer measures is the quorum that runs
  until the flag is deliberately flipped.
- **A non-responding NIM degrades, it does not bias.** On any failure `queryProvider`
  returns an `ERROR` verdict; aggregation counts only non-error responses
  (`providers_used`), computes agreement/score over successes only, and
  `MIN_QUORUM_FOR_VETO = 2` means a lone survivor defaults to `clean` (degraded).
  A dead or keyless NIM therefore lowers coverage, never contributes a zero-risk
  vote. This is explicitly **not** the attestation-minter shape (a non-responder
  scored as `{validity:0}` folded into the mean): that was in `runPCP`, a
  different path; here the ERROR is filtered out before the mean.
- **Family independence.** NIM is `nvidia` (Nemotron) — NVIDIA's own architecture,
  independent of the always-on `groq`(llama)/`cerebras`(glm) families, so when
  enabled it is a genuine additional vote toward the 2-family veto quorum. If
  `HAL_S2_ENABLE_FRONTIER_FREE` is also on, `or-nemotron` is ALSO family `nvidia`
  (via OpenRouter) and the two **dedupe to one family vote** — correct (same
  weights, different host), never counted as two.

**NOT CHECKED (needs Sean's key + a live probe):**
- Whether `nvidia/nemotron-4-340b-instruct` is a live id on
  `integrate.api.nvidia.com`. No NVIDIA key is reachable from a dev sandbox; the
  default is from NVIDIA's published catalog, unverified against a real call.
  Treat a green build as NOT_CHECKED on this string — the same posture the repo
  already takes on the groq/cerebras/gemini defaults. First verification is
  post-deploy against `provider_health` (per-provider success/fail), model
  overridable via `HAL_S2_NVIDIA_NIM_MODEL` without a redeploy.
- NIM's real verdict quality/latency and its effect on live F1. Do not recommend
  `HAL_S2_ENABLE_NVIDIA_NIM=true` in production until a measured run at a stated
  corpus + ruler (CLAUDE_RULES 24) shows the family adds signal, not just cost.

**FAILED:** none introduced by this change. The whole-tree `named-env-vars.test.ts`
fails **on this machine only**, on three tokens (`ANON_KEY`, `HUGGINGFACE_API_KEY`,
`MARKETPLACE_SETTLEMENT_ENABLED`) that live exclusively under `.claude/worktrees/`
— local Claude Code worktrees, 0 tracked files, absent from any CI checkout. No
flagged token is outside `.claude/worktrees/`, and none is in my files (LESSONS
rule 7: ENV/CONFIG, not REAL).

## The LOCAL_LLM_BASE_URL constraint — what NIM + a gateway means

`buildFactCheckProvidersWith` redirects **every** openai-compat member's endpoint
through `resolveProviderEndpoint(endpoint, LOCAL_LLM_BASE_URL, 'openai-compat')`
when that var (or `OPENAI_BASE_URL`) is set. NIM is openai-compat, so it is
redirected with the rest — it is not special-cased and cannot opt out.

Concretely, for a NIM + gateway combination:
- Setting `LOCAL_LLM_BASE_URL` to point the quorum at a local Ollama/vLLM/LiteLLM
  box **also redirects NIM there** — the call no longer reaches
  `integrate.api.nvidia.com`. You get a NIM-*named* verdict answered by whatever
  the gateway serves at that model slug. If the gateway does not host a Nemotron
  under the configured id, NIM contributes an ERROR (not a silent wrong answer),
  and the `nvidia` family drops from the quorum.
- Under the data-locality boundary (`ONLY_ATTESTATIONS_LEAVE=true`) this is the
  intended behaviour — content stays on the box — but it means you cannot run
  "local gateway for the free tier, NIM direct to NVIDIA" at the same time: the
  base URL is global to all openai-compat members. To use NIM against NVIDIA's
  own endpoint, leave `LOCAL_LLM_BASE_URL` unset (anthropic-dialect members are
  dropped under a local base; NIM, being openai, is redirected instead).

> **The credential half, added 2026-09-09.** The list above enumerates what the redirect does to
> *routing* and stops there, which reads as though the cost were a wrong-verdict risk. It is not
> the whole cost: the redirect rewrites `p.endpoint` and leaves `p.apiKey` **untouched**, so
> `queryProvider` sends `Authorization: Bearer <that provider's key>` to the new host. The key
> follows the endpoint.
>
> **MEASURED 2026-09-09** — quorum built with one distinct fake key per provider and
> `LOCAL_LLM_BASE_URL` set: **10 of 10 providers redirected, 10 distinct credentials handed to
> that one host** (groq, fireworks, deepseek, gemini, mistral, zai, nvidia-nim, openrouter, gloo,
> qwen). A floor, not a ceiling — cerebras was absent only because its own dead-model skip had
> already dropped it.
>
> So the NIM key is not the exposure; it is one of the ten measured. "Local gateway" must mean a host you
> control. Anthropic-dialect members are dropped rather than redirected, so their key is the one
> that does not travel — which the routing note above already says, without saying why it matters.

## Recommendation

Ship default-OFF as-is. Before flipping `HAL_S2_ENABLE_NVIDIA_NIM=true`: set the
key on the `repid-engine` service, run one quorum, read `provider_health` to
confirm the model id answers, then a measured F1 run at a stated ruler. Do not
enable it in the same change as anything else, so a quorum-width or F1 move is
attributable to NIM alone.
