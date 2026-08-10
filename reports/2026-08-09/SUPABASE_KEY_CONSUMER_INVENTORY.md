# Supabase Key Consumer Inventory — Go/No-Go for Legacy JWT Revocation

**Project:** `qnnpjhlxljtqyigedwkb` (AITrinitySymphony / Trinity prod)
**Goal:** revoke the LEGACY `eyJ...` JWT keys (`service_role` + `anon`), leaving only NEW-format `sb_secret_...` / `sb_publishable_...`.
**Method:** read-only disk grep across all `C:\Users\Cash4\repos\*` for Supabase key reads, plus a live `list_edge_functions` on the target project. **No key values are reproduced** (repo is PUBLIC).
**Date:** 2026-08-09

## The rule that decides each row
A consumer is **SAFE** only if it can read the NEW key. Two ways that happens:
1. Code references a new-format env name first (`SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY || ...`) **and** that new-name env var is populated with the `sb_secret_...` value; or
2. Code reads a legacy name (`SUPABASE_SERVICE_ROLE_KEY`, etc.) but the **value** stored under that name at deploy is swapped to the new `sb_secret_...` string (env-var override — the name is legacy, the value is new).

A consumer **BREAKS** if the only value it can resolve is a genuine legacy `eyJ...` JWT — including Supabase's **auto-injected** `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_ANON_KEY` in every edge function, which are legacy JWTs unless explicitly overridden with a secret of the same name.

---

## Class A — Edge functions DEPLOYED on qnnpjhlxljtqyigedwkb (live)
`list_edge_functions` returned **~60 ACTIVE functions** on this project. Supabase auto-injects the legacy `service_role`/`anon` JWTs into every one. Any that call `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` or `'SUPABASE_ANON_KEY')` read a legacy value unless a per-function secret override is set. **Most of these functions' source is NOT on local disk** (deployed via Lovable / `make-server` / other tooling), so their exact key reads could not be inspected file-by-line. Treat the whole class as legacy-key consumers pending per-function secret override.

Disk source WAS found for these deployed-on-target functions (all read the auto-injected legacy service_role JWT, no new-key name):

- [ ] `trusttrader/supabase/functions/generate-merkle-batch/index.ts` reads `SUPABASE_SERVICE_ROLE_KEY` — new-key fallback? **no** *(deployed as `generate-merkle-batch`)*
- [ ] `trusttrader/supabase/functions/hal-notify/index.ts` reads `SUPABASE_SERVICE_ROLE_KEY` — new-key fallback? **no** *(deployed as `hal-notify`)*
- [ ] `trusttrader/supabase/functions/sprint-reader/index.ts` reads `SUPABASE_SERVICE_ROLE_KEY` — new-key fallback? **no** *(deployed as `sprint-reader`)*
- [ ] `trusttrader/supabase/functions/update-signals/index.ts` reads `SUPABASE_ANON_KEY` — new-key fallback? **no** *(deployed as `update-signals`)*
- [ ] `trustrails-dev/supabase/functions/send-waitlist-welcome/index.ts` reads Supabase key — new-key fallback? **no** *(deployed as `send-waitlist-welcome`; verify env name)*

Live functions whose source is server-side only (inspect each for `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_ANON_KEY` before revoking) include, among others: `raven-constitutional-decisions`, `atlas-constitutional-decisions`, `agent-heartbeat-keepalive`, `autonomous-coordinator`, `telegram-commander`, `trinity-dashboard-api`, `agent-tools`, `claude-relay`, `ai-dispatch`, `mint-dbt`, `sophia-trade-loop`, `zkp-repid-proof`, `x402-gate`, `agent-card`, `hal-mediate-challenge`, `measure-learn-improve`, `mobile-controller`, `trustshell-trading-api`, `trustex-api`, `trusttrader`, `make-server-e172c8d9`, `auto-healer` / `auto-healer-v2`, plus the Stripe/email/voice set (`create-checkout`, `customer-portal`, `check-subscription`, `payment-automation`, `send-*-email`, `voice-to-text`, `openai-realtime`, etc.).

- [ ] **ALL ~60 live edge functions** — audit each for a Supabase key read; any hit on `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_ANON_KEY` — new-key fallback? **no, unless per-function secret override set**

## Class B — repid-engine services (API + receipt-indexer + proof-drain-worker)
All use the **new-key-first chain** (`SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY || SUPABASE_SERVICE_KEY || ...`). SAFE **only if `SUPABASE_SECRET_KEY` is populated with the `sb_secret_...` value on the `repid-engine` Railway service**; if that var is empty they fall through to the legacy `SUPABASE_SERVICE_ROLE_KEY` and break.

- [ ] `repid-engine/src/config.ts` reads `SUPABASE_SECRET_KEY → SERVICE_ROLE_KEY → SERVICE_KEY → SUPABASE_KEY` — new-key fallback? **yes (first)** *(central; feeds `src/db.ts`, `circuit-breaker.ts`, `graph-rag-edge-inference.ts`)*
- [ ] `repid-engine/src/scripts/start-proof-drain-service.ts` reads `SUPABASE_SECRET_KEY → SERVICE_ROLE_KEY → SERVICE_KEY` — new-key fallback? **yes (first)** *(the `proof-drain-worker` Railway service — DB writer)*
- [ ] `repid-engine/src/scripts/start-indexer-service.ts` reads `SUPABASE_SECRET_KEY → SERVICE_ROLE_KEY → SERVICE_KEY` — new-key fallback? **yes (first)** *(the `receipt-indexer` Railway service — DB writer)*
- [ ] `repid-engine/src/routes/stake.ts` reads `SUPABASE_SECRET_KEY → SERVICE_ROLE_KEY → SERVICE_KEY` — new-key fallback? **yes (first)**
- [ ] `repid-engine/src/routes/telegram.ts` reads `SUPABASE_SECRET_KEY → SERVICE_ROLE_KEY → SERVICE_KEY` — new-key fallback? **yes (first)**
- [ ] `repid-engine/src/routes/hal-test.ts` reads `SUPABASE_SECRET_KEY → SERVICE_ROLE_KEY → SERVICE_KEY` — new-key fallback? **yes (first)**
- [ ] `repid-engine/src/services/hal-tester.ts` reads `SUPABASE_SECRET_KEY → SERVICE_ROLE_KEY → SERVICE_KEY` — new-key fallback? **yes (first)**
- [ ] `repid-engine/src/services/x402-real-settler.ts` reads `SUPABASE_SECRET_KEY → SERVICE_ROLE_KEY → SERVICE_KEY` — new-key fallback? **yes (first)** *(DB writer — settlements)*
- [ ] `repid-engine/src/db/direct-pg.ts` uses `DATABASE_URL`/`SUPABASE_DB_URL` (Postgres connstring, **not a JWT**) — new-key fallback? **n/a (unaffected by JWT revocation)**

**repid-engine ops/dev scripts** (not always-on runtime, but will fail if run post-revoke without `SUPABASE_SECRET_KEY`). Mixed: several read legacy names FIRST with **no** new-key name:

- [ ] `repid-engine/scripts/drain-proof-queue.ts` reads `SUPABASE_SERVICE_ROLE_KEY` — new-key fallback? **no**
- [ ] `repid-engine/scripts/anchor-zkp-epoch-via-rest.ts` reads `SUPABASE_SERVICE_KEY → SERVICE_ROLE_KEY` — new-key fallback? **no**
- [ ] `repid-engine/scripts/audit-probe/run-audit-probe.ts` reads `SERVICE_ROLE_KEY → SERVICE_KEY` — new-key fallback? **no**
- [ ] `repid-engine/scripts/audit/verify-chain.ts` reads `SERVICE_KEY → SERVICE_ROLE_KEY` — new-key fallback? **no**
- [ ] `repid-engine/scripts/diag/inject-and-watch.ts` reads `SERVICE_KEY → SERVICE_ROLE_KEY` — new-key fallback? **no**
- [ ] `repid-engine/scripts/compute-anfis-a3-shadow.ts` reads `SERVICE_KEY → SERVICE_ROLE_KEY` — new-key fallback? **no**
- [ ] `repid-engine/scripts/generate-state-of-system.ts` reads `SERVICE_ROLE_KEY → SERVICE_KEY` — new-key fallback? **no**
- [ ] `repid-engine/scripts/erc8004-backfill-*.ts`, `erc8004-reputation-backfill-*.ts`, `graph-rag-smoke.ts`, `erc8004/canonical-register.ts`, `e2e/negotiated-zkp-exchange.mjs`, `demo/trust-receipt.mjs` — all read `SERVICE_ROLE_KEY`/`SERVICE_KEY` only — new-key fallback? **no** *(dev/ops scripts; fix by exporting `SUPABASE_SECRET_KEY` value under a legacy name when run)*

## Class C — trinity-symphony-shared (the 12 constitutional agents) — HIGHEST RISK
This repo runs against `qnnpjhlxljtqyigedwkb`. **Zero references to any new-format name** (`SUPABASE_SECRET_KEY` / `SUPABASE_PUBLISHABLE` / `sb_secret` / `sb_publishable`) anywhere in the repo — confirmed by grep. Every consumer reads legacy names ONLY. On revocation these break unless the legacy-named Railway vars are given the new `sb_secret_...` **value**.

- [ ] `trinity-symphony-shared/lib/supabase.ts` reads `SERVICE_ROLE_KEY → SERVICE_KEY → NEXT_PUBLIC_SUPABASE_ANON_KEY` **and a HARDCODED legacy anon JWT fallback is present at line 12** (value NOT reproduced; ref = this project, role anon) — new-key fallback? **no** *(exported `supabase` client used repo-wide; the hardcoded fallback means it silently keeps using a legacy anon key even if env is cleared)*
- [ ] `trinity-symphony-shared/constitutional-agent-base.js` (line 292/294) reads `SUPABASE_KEY` / `SERVICE_ROLE_KEY → SERVICE_KEY → SUPABASE_KEY` — new-key fallback? **no** *(base class for the constitutional agents — DB writer)*
- [ ] `trinity-symphony-shared/lib/ConstitutionalAgent.ts` (line 210/1805) reads `SERVICE_ROLE_KEY → SERVICE_KEY → NEXT_PUBLIC_SUPABASE_ANON_KEY` — new-key fallback? **no** *(DB writer)*
- [ ] `trinity-symphony-shared/lib/ConstitutionalAgentV4.js` (line 225) reads `SERVICE_ROLE_KEY → SERVICE_KEY → SUPABASE_ANON_KEY` — new-key fallback? **no** *(DB writer)*
- [ ] `trinity-symphony-shared/auto_updater.js` (line 22/24) reads `SERVICE_ROLE_KEY → SERVICE_KEY → SUPABASE_KEY → NEXT_PUBLIC_SUPABASE_ANON_KEY` — new-key fallback? **no**
- [ ] `trinity-symphony-shared/sync-docs.js` reads `SERVICE_ROLE_KEY → SUPABASE_KEY → NEXT_PUBLIC_SUPABASE_ANON_KEY` — new-key fallback? **no**
- [ ] `trinity-symphony-shared/conductor/conductor.py` reads `SUPABASE_SERVICE_KEY` (required) — new-key fallback? **no**
- [ ] `trinity-symphony-shared/test-v82-reflection.js` reads `SUPABASE_SERVICE_ROLE_KEY` — new-key fallback? **no**
- [ ] `trinity-symphony-shared/render-apm.yaml`, `render-mel.yaml` declare `SUPABASE_SERVICE_ROLE_KEY` env — new-key fallback? **no** *(Render deploy manifests — confirm these services are retired vs live)*

## Class D — Other repos' edge functions (deploy to OTHER projects, but reach into Trinity)
- [ ] `aitc/supabase/functions/agent-status|agent-sync|agent-tasks/index.ts` read `TRINITY_SYMPHONY_ANON_KEY` (+`TRINITY_SYMPHONY_URL`) — new-key fallback? **no** *(config.toml `project_id = okhxunwnknfhycnxcvdx` — deployed elsewhere but write to Trinity's `trinity_logs` via a cross-project ANON key; breaks on Trinity `anon` revocation if that var holds a legacy JWT)*
- [ ] `_aitc_audit/supabase/functions/agent-status|agent-sync|agent-tasks/index.ts` — same as above (audit copy) — new-key fallback? **no**
- [ ] `trinity-ecosystem/supabase/functions/agent-tools/index.ts` reads `SUPABASE_SERVICE_ROLE_KEY` (auto-injected) — new-key fallback? **no** *(deploy target not pinned in config.toml — confirm whether this is the live `agent-tools` on qnnpjhlxljtqyigedwkb)*
- [ ] `trusttrader/supabase/functions/{agent-challenge,agent-decision-generator,sprint-runner,hal-stress-test}/index.ts` read `SUPABASE_SERVICE_ROLE_KEY` (auto-injected) — new-key fallback? **no** *(confirm deploy project per function)*

---

## RISK VERDICT

**If the legacy `service_role` + `anon` JWTs are revoked today, a large number of consumers break — this is a NO-GO until overrides are in place.**

The breakage splits three ways:

1. **The ~60 live edge functions on `qnnpjhlxljtqyigedwkb` (Class A)** — Supabase auto-injects the legacy `service_role`/`anon` JWTs into all of them. Any function reading those names breaks the instant the legacy keys are revoked, unless each function gets a secret override of the same name set to the new value. Most of these functions' source is server-side and was not inspectable from disk, so the true count of service_role readers is unknown and must be enumerated per-function before revocation. This is the largest unknown.

2. **trinity-symphony-shared — the 12 constitutional agents (Class C)** — the **highest-risk DB writers**. The repo has **no new-format key name anywhere**; every agent reads `SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_SERVICE_KEY` and falls back to legacy anon. `lib/supabase.ts:12` even carries a **hardcoded legacy anon JWT** as a last-resort fallback, so clearing the env does not stop it using a legacy key — it must be edited out. These break unless the Railway vars `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_SERVICE_KEY` on every agent service are re-valued to the new `sb_secret_...` string (name legacy, value new).

3. **repid-engine (Class B)** — the safest tier: API, `receipt-indexer`, and `proof-drain-worker` all try `SUPABASE_SECRET_KEY` first. They survive revocation **only if `SUPABASE_SECRET_KEY` is actually populated** with the `sb_secret_...` value on the `repid-engine` service; if it is empty, they silently fall through to the legacy `SUPABASE_SERVICE_ROLE_KEY` and break too. Its ops/dev scripts read legacy names directly and will fail unless run with the new value exported.

**Highest-risk DB writers to protect first:** the trinity-symphony-shared constitutional agents (`constitutional-agent-base.js`, `ConstitutionalAgent.ts`, `ConstitutionalAgentV4.js`), the repid-engine `proof-drain-worker` / `receipt-indexer` / `x402-real-settler.ts` (only safe if `SUPABASE_SECRET_KEY` is set), and any live edge function writing to the DB (`raven`/`atlas-constitutional-decisions`, `autonomous-coordinator`, `agent-heartbeat-keepalive`, `zkp-repid-proof`, `mint-dbt`, etc.). **Go criteria:** (a) populate the new `sb_secret_...` value into `SUPABASE_SECRET_KEY` on repid-engine and into the legacy-named vars on every trinity-symphony-shared agent service; (b) set per-function secret overrides for every live edge function that reads an auto-injected key; (c) remove the hardcoded legacy anon JWT in `trinity-symphony-shared/lib/supabase.ts`; (d) confirm each item above, then revoke.
