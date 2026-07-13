# SPIKE — merged grader/arbiter VERDICT schema + litellm cache / code-mode recon (task 31)

**Sprint:** sprint-2026-07-12-ecosystem · **Lane:** verdict-schema + infra-recon (spec/recon, **no prod
writes**) · **Date:** 2026-07-12 · **Branch:** `feat/cc-2026-07-12-verdict-schema-spike`
**Deliverables:** `src/hal/verdict-schema.ts` (spec-as-code, **inert** — imported by nothing),
`tests/verdict-schema.test.ts` (8 green), this doc. Did **not** touch routing tables (my other lane).

---

## Part (a) — the typed VERDICT schema (map priority 3, the HAL/RepID keystone)

### Problem
HAL runs two shapes **separately** today:
- **CRAG-grade** — grade each candidate as relevant/irrelevant/ambiguous (`src/hal/fact-check.ts` →
  `FactCheckResult`: per-provider `TRUE/FALSE/UNCERTAIN`, family-aware quorum, `decision`, `decision_reason`).
- **Arbiter-rank** — rank/critique candidates and pick one (`src/services/adversarial-judge.ts` →
  `AdversarialJudgeResult`: `APPROVE/CHALLENGE/ESCALATE` + `critique` + `judge_provider`).

Two calls, two objects, no single artifact that is at once the answer, the trust signal, and the audit
record.

### Design — one object, one call, three jobs
`HalVerdict` (`src/hal/verdict-schema.ts`) is emitted by **one** LLM call that does BOTH the CRAG grade
and the arbiter rank (`provenance.merged_single_call = true`). The same object is:

1. **The answer** — `outcome.decision` (`answered | not_found | contested | refused`),
   `outcome.selected_candidate_id`, `outcome.answer`.
2. **A RepID trust event** — `toRepidScoreEvent(v, {agent_id})` projects onto the **real**
   `repid_score_events` columns (`llm_provider`, `llm_model`, `task_domain`, `hal_score`, `hal_decision`,
   `decision_outcome`, `hallucination_caught`, `metadata`). `hal_decision` reuses fact-check's exact
   domain (`clean|flagged|vetoed|abstain`) so nothing downstream changes.
3. **A HyperDAG audit input** — `toAuditChainArgs(v, sourceId)` projects onto the **real** signature
   `append_hal_audit_chain(p_source_table, p_source_id, p_event_payload jsonb, p_canonical_json_text)`
   (verified live 2026-07-12). `canonicalJson()` emits sorted-key bytes so the hash chain is
   order-independent and reproducible.

### Per-candidate: role + reason + provenance
Each `VerdictCandidate` carries `grade` (CRAG: correct/incorrect/ambiguous), `role` (arbiter:
primary/supporting/contradicting/irrelevant/duplicate), `rank`, `confidence`, a one-line `reason`,
`keyword_hits`, and `provenance {provider, model, family, call_id, latency_ms}`. `family` reuses the
independence-family notion from `fact-check.ts` (two same-family candidates = one vote), so the merged
verdict inherits HAL's spoof-resistant quorum.

### not_found via the keyword-absence axiom (anti-hallucination)
`isKeywordAbsent(candidates)` is a hard, **deterministic post-check over the model's structured output**:
if NO candidate contains ANY `question_keywords` hit, the outcome is forced to `not_found`
(`keyword_absence = true`, `answer = null`). The model may not invent an ungrounded answer; the axiom is
enforced in code, not trusted to prose. (An empty keyword set ⇒ "cannot ground" ⇒ `not_found`.)

### Latency fit
Cowork measured HAL: **p50 ~0 ms** (stages 1–2 inline at the median), **p95 ~3155 ms** (tail = LAO's 3 s
threshold; LAO covers the tail). Merging grade+arbiter into ONE call removes a round-trip on the hot
path, keeping the common case inline and the tail within LAO's existing budget. The verdict object adds
no extra inference — it is a re-shape of signals HAL already computes.

### Wiring (follow-up, NOT in this spike)
When greenlit: the fact-check quorum + adversarial judge emit a `HalVerdict` instead of two objects;
`toRepidScoreEvent` feeds the score path; `toAuditChainArgs` feeds `append_hal_audit_chain`. The JSON
Schema (`HAL_VERDICT_JSON_SCHEMA`, draft-07) lets other lanes / the wrapper validate the object off the
wire. All gated + measured before it steers any live RepID delta (Sean-gated).

---

## Part (b) — infra recon (map priorities 1 & 5)

> ⚠ **Verification boundary.** Railway programmatic access is **token-blocked** (STATE_OF_THE_SYSTEM
> 2026-07-01: `RAILWAY_API_TOKEN` stale). I could **not** inspect the live `trinity-litellm` container,
> its mounted `config.yaml`, or provision a sandbox. Findings below are grounded in the **repo** + the
> known capabilities of the pinned tools; each live-verification step is flagged **[BLOCKED: Railway]**.

### (1) Does trinity-litellm support **semantic caching**?
**Repo facts (verified):**
- The engine already has an **app-level cache** — `src/cache/semantic-cache.ts` — but it is **exact-match**,
  not embedding-semantic: it keys on `sha256(lower(trim(query)))`, backed by Dragonfly (Redis) with a
  Supabase `semantic_cache` table write-through (12 h TTL). Two paraphrases of the same question **miss**.
- `litellm` is present only as an **escalation provider proxy** serving `hf/*` models
  (`src/decisioning/family-registry.ts`), not as a caching layer the engine relies on.

**Capability:** LiteLLM proxy natively supports caching with backends `local | redis | s3 | qdrant` and a
**`redis-semantic` / `qdrant-semantic`** mode (embedding + cosine `similarity_threshold`). So the
capability exists **in LiteLLM**; whether the **deployed trinity-litellm build** has it **enabled**
depends on its mounted `config.yaml` (`litellm_settings.cache: true`, `cache_params.type: redis-semantic`,
an embedding model, a similarity threshold) and a reachable Redis/Qdrant. **[BLOCKED: Railway]** — need to
read the live `config.yaml` + the litellm image version.

**Recommendation (cheapest → best):**
1. **Reuse the existing Dragonfly/Redis** as LiteLLM's `redis-semantic` backend → central semantic cache
   for *every* engine→litellm call, one config change, no app code. Preferred.
2. If the litellm image is too old for `redis-semantic`, **upgrade the app-level cache**
   (`semantic-cache.ts`) from sha256-exact to embedding-similarity against the same `semantic_cache`
   table (add an embedding column + a top-k cosine lookup). More code, but engine-owned and provider-agnostic.
- **Net:** the primitive (Redis/Dragonfly) is already deployed; the gap is config, not infrastructure.

### (2) Can a **Railway sandbox host code-mode** (script execution)?
"Code-mode" = executing model-generated scripts in an isolated executor. **No sandbox exists in the repo
today** (grep: no runner service, no `vm2`/`isolated-vm`/firecracker/gVisor reference).

**Feasibility on Railway:**
- Railway can host a **dedicated service** (its own Nixpacks/Dockerfile) that runs a restricted executor
  and is reachable only from the engine over the private network — a natural "code-mode" host, isolated
  from the scoring path.
- **Isolation is the crux.** A Railway *service* is a container, **not** a per-request microVM; running
  untrusted generated code needs an in-container sandbox (`isolated-vm` / `vm2`-successor for JS, or
  `nsjail`/gVisor for arbitrary processes) + no secrets in that service's env + strict egress + a hard
  wall-clock/memory cap. Railway gives the container; the sandbox is on us.
- **Cheaper alternative to evaluate first:** a hosted code-execution API (e2b / Modal / Deno Deploy
  subhosting) may beat self-hosting a hardened sandbox for the same isolation guarantee.

**Verdict:** *host* — yes, feasible as a separate Railway service; *safe untrusted execution* — only with
an added in-container sandbox layer + secret/egress lockdown. **[BLOCKED: Railway]** — provisioning +
a resource/isolation test need the token restored.

### Unblock list (for Sean)
- Restore `RAILWAY_API_TOKEN` → then: (i) read `trinity-litellm` `config.yaml` + image version to confirm
  `redis-semantic` support; (ii) stand up a throwaway sandbox service to measure isolation + wall-clock.
- Decision owed: LiteLLM-proxy semantic cache (recommended) vs engine-side embedding cache upgrade.
