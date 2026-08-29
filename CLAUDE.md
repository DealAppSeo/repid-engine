# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## READ `LESSONS.md` FIRST — it is shared with XC, GA and the swarm

[`LESSONS.md`](LESSONS.md) at the repo root holds the operating rules every agent on this
system works under. It is **injected verbatim** into every XC/GA dispatch by
`scripts/dispatch/run-agent.mjs`, and it is the one place a lesson is durable across
*all* of them.

**Why it is there and not here.** This repo holds 116 dated report files, and until
2026-08-05 this file referenced none of them. `reports/2026-07-31/SCHOOL_OF_HARD_KNOCKS`
already recorded "unverified inference — again, **third occurrence**"; the same class
recurred twice more that day. Filing a lesson does not prevent its recurrence. Only
putting it in front of the worker does.

**Why one file in git, rather than each surface keeping its own.** There are five
memory stores here — living-docs, `~/.claude` project memory, the claude-mem plugin,
`reports/`, and these CLAUDE.md files — and **XC and GA can read none of them.** The
dispatch preamble is the only channel that reaches those two. A file in git is the only
store every reader can see, and it is the only one where a disagreement surfaces as a
version-control conflict instead of two copies quietly drifting apart.

**Adding to it:** it has a hard 6000-character cap enforced by
`tests/lessons-injectable.test.ts`. The cap is the mechanism, not tidiness — an
un-injectable file becomes the 117th report nobody reads. A new lesson must replace or
generalise an existing one. Narratives stay in `reports/<date>/`.

## What this is

`repid-engine` is the proprietary behavioral reputation scoring backend for the HyperDAG Protocol Trust* ecosystem (`trustrepid.dev` · github.com/DealAppSeo/hyperdag-protocol). It is an Express API that mutates agent reputation (`repid`) scores in Supabase and stubs out an EAS / ERC-8004 / ZKP attestation pipeline.

> ## ⚠ THIS REPOSITORY IS **PUBLIC**
>
> Verified 2026-08-04: `gh api repos/DealAppSeo/repid-engine --jq .visibility` → **`public`**.
>
> This line previously read *"Private, proprietary — not for public distribution."*
> **That was false**, and `INFRA_INVENTORY.md` repeats the same error. Every agent that
> read this file inherited the wrong premise — including one that published a detailed
> account of a committed production key, naming the file and the project, in a public
> pull request body.
>
> **Consequences that are not optional:**
> - Everything in this repo, every PR title, body and comment, and every commit message
>   is world-readable and permanent. A published secret cannot be withdrawn.
> - State FINDINGS, not inventories. *"A production key was committed and must be
>   rotated"* is actionable. The key, the project id, the row counts and the service
>   names are an incident.
> - Secrets in git HISTORY are public even after the file is deleted from `HEAD`.
>   Deletion is not rotation.
> - `scripts/hooks/publication-guard.js` blocks the shapes it can recognise. It cannot
>   recognise prose, so the judgement about metrics and identifiers is yours.
>
> The code remains proprietary by licence; it is not private by access.

## Commands

```bash
npm install --legacy-peer-deps   # required — plain `npm install` will fail (matches nixpacks.toml)
npm run dev                       # ts-node src/index.ts
npm run build                     # tsc → dist/
npm start                         # node dist/index.js (production entry, also Railway start command)
npm test                          # jest --config jest.config.js --forceExit
npx jest --config jest.config.js tests/repid-score.test.ts   # single file
npx jest --config jest.config.js -t "<test name substring>"  # single test by name
```

**`--config jest.config.js` is not optional.** The repo has *both* a `jest.config.js` and a vestigial `jest` key in `package.json`, so a bare `npx jest ...` aborts with *"Multiple configurations found … Implicit config resolution does not allow multiple configuration files."* `npm test` works only because the script already passes the flag. (The real fix is to delete one of the two configs; until someone does, pass the flag.)

`SUPABASE_URL` and a service key are required at boot — `src/config.ts:46` throws otherwise (it accepts `SUPABASE_SECRET_KEY`, or a legacy `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_SERVICE_KEY` fallback). **No `.env` is committed, and `.env` is gitignored** — `.env.example` is the only env file in the tree and it ships those two values *empty*. So a fresh clone does **not** boot, and several test suites fail at import rather than skipping. Export dummies yourself for local work:

```bash
export SUPABASE_URL=http://localhost:54321 SUPABASE_SERVICE_KEY=dummy
```

**These dummies only let `src/config.ts` BOOT — they do NOT enable the integration
tests.** Integration suites are opt-in and require `RUN_INTEGRATION=1` alongside real,
reachable credentials; without it they skip. Do not expect `localhost:54321` to make a
DB-touching suite pass — it satisfies config's presence check, not a live database, so a
suite that armed on presence alone would try to reach a Supabase that isn't there. (Guards
gate on `RUN_INTEGRATION=1`, never on credential presence — see
`tests/helpers/run-integration.ts`.)

Real credentials come from Railway env vars at deploy; never commit them.

## Test layout — important quirk

There are **three** categories of test directory in this repo, and only two of them run:

- `tests/*.test.ts` — runs. This is where new tests belong.
- `src/hal/lib/__tests__/*.test.ts` — **also runs.** `jest.config.js` pins `roots: ['<rootDir>/tests', '<rootDir>/src/hal/lib/__tests__']`, so this one `__tests__` directory (2 files: `adversarial`, `comma-override`) is covered. Don't assume changes under it are untested.
- Every *other* `src/**/__tests__/` — **not picked up by `npm test`.** There are six such directories (`src/billing`, `src/layers`, `src/providers`, `src/routes`, `src/services`, `src/services/reputation`) and jest never sees them. They also get compiled into `dist/` because `tsconfig.json` only excludes the top-level `tests/` directory, not `__tests__` subfolders.

If you add tests, put them under `tests/` to make them run. If you touch a file under one of the six unrooted `__tests__` folders, decide explicitly whether to relocate it or extend the jest `roots` — a green `npm test` says nothing about it.

## Architecture

### Request pipeline (`src/index.ts`)

```
helmet → cors (allowlist) → express.json (1mb) → SQL-keyword body sanitizer
       → authMiddleware → rateLimitMiddleware → versioningMiddleware → routers
```

- The **SQL-keyword sanitizer** rejects any POST whose body contains the strings `SELECT `, `DROP `, `INSERT `, `UPDATE `, `DELETE `, `--`, or `;` (case-insensitive). This is broad and will reject legitimate text payloads — be aware when adding endpoints that accept user prose.
- `authMiddleware` validates `Authorization: Bearer <key>` or `x-api-key` against `REPID_API_KEYS` (comma-separated `key:tier` pairs, e.g. `secret123:pro,corp_key:enterprise`). It **bypasses auth** for `GET /api/v1/repid/*` and `GET /api/v1/erc8004/validate/*`.
- `versioningMiddleware` reads `X-RepID-Version` (default `2026-04-17`) and lazily ensures the `api_key_versions` table exists by calling a Supabase RPC named `run_sql` on the first request after process start. That RPC must exist in the Supabase project.
- `scoreMonitor` runs every 5 minutes via `setInterval` after `app.listen` (anomaly detection on `repid_agents`).

### Scoring pipeline (`src/engine/repid-update.ts`)

`updateRepId(input)` is the heart of the engine. Every score-changing event flows through this fixed sequence:

1. Fetch agent from `repid_agents`.
2. **Constitutional audit** (`src/layers/constitutional-audit.ts`) — LASSO rule selection + ANFIS fuzzy scoring + mirror test + EAS attestation. **Currently stubs that always pass with score 1.0**; real implementation is "Sprint 3". As of 2026-07-05 this layer is gated behind `CONSTITUTIONAL_AUDIT_ENABLED` (default FALSE) and is **non-load-bearing** — its output does not influence any RepID delta, challenge verdict, or MCP tool gate while disabled (RULE-4: no fake-pass may steer scoring or be reported as a real measurement).
3. **Decay** (`src/layers/decay.ts`) — applied to current score based on 30-day activity.
4. **Ecosystem need weight** (`src/layers/ecosystem-need.ts`) — multiplier from `repid_ecosystem_supply`.
5. **Delta** — challenge events go through `scoreChallengeOutcome`, predictions through `scorePrediction`, everything else uses the `FIXED_DELTAS` table (STAKE=5, REFERRAL=20, PEACEMAKER=15, CODE_CONTRIBUTION=25, etc.).
6. **Redemption modifier** (`src/layers/decay.ts`) — only applied when delta is negative; dampens punishments for prosocial agents.
7. Compute new RepID, **clamped to [10, 10000]**, then derive tier via `computeTier`: `0–499 → PROBATIONARY`, `500-999 → EARNING`, `1000–4999 → ESTABLISHED`, `5000-7999 → AUTONOMOUS`, `8000-10000 → VETERAN`.
8. Write back to `repid_agents`, append a row to `repid_score_events` (full audit trail including EAS attestation id, mirror-test flag, decay/redemption metadata).
9. `updateSupplyRate` — bumps `repid_ecosystem_supply` counters.
10. `checkAndAwardBadges` — non-blocking; failures are swallowed so badges never break scoring.

When adding a new event type, update `RepIdUpdateInput.eventType`, the `challengeTypes` set if it's adversarial, and either `FIXED_DELTAS` or a dedicated scorer.

### Supabase tables

The engine reads/writes only these tables (no migrations live in this repo — schema is managed externally):

- `repid_agents` — agent state (current_repid, tier, constitution, activity_30d, erc8004_address)
- `repid_score_events` — append-only audit log of every score change
- `repid_badges` — milestone awards
- `repid_bounties` — bounty lifecycle
- `repid_webhooks` — webhook registrations
- `repid_mcp_tools`, `trinity_tool_usage` — MCP tool registry/usage
- `repid_ecosystem_supply` — supply-rate counters per event type
- `trinity_agent_logs` — auth / ZKP / monitoring events (write-only from this codebase)
- `hal_production_events` — HAL production logging
- `api_key_versions` — version-pinning per API key (auto-created on first request)
- `social_content_queue` — the publish queue. **Its gate is a DB CHECK, not app code**:
  `social_content_queue_verified_before_publish` refuses any row in a publishable state
  (`ready`/`approved`/`scheduled`/`posted`) unless `hal_decision` is set and is not `vetoed`.
  A NULL verdict means NOT CHECKED and is refused — not checked is not the same as passed.
  It is `NOT VALID`, grandfathering rows that predate verification; validate it once those are
  cleared. Write through `src/services/social-publish-gate.ts` so the verdict is recorded
  honestly — but do not treat that module as the enforcement point, which is the whole reason
  the constraint exists.

The Supabase project ID is **not** committed; the only artifacts are `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` injected at runtime.

### Layers vs engine vs routes

- `src/layers/` — pure-ish scoring math (decay, prediction, challenge, ecosystem-need, constitutional-audit). Most are stubs awaiting Sprint 3.
- `src/engine/` — orchestration (`repid-update`, `badges`, `mcp`, `score-monitor`, `production-logger`, `hashkey-chain`).
- `src/routes/` — Express routers, mounted in `src/index.ts`. **Order matters**: `challengeRouter` is mounted before `scoreRouter` because of conflicting `/challenge` paths.
- `src/zkp/` — `plonky3-stub.ts` (always-on) and `plonky3-real.ts` (Sprint 3 wiring). Both log to `trinity_agent_logs`.

### On-chain integration

`src/engine/hashkey-chain.ts` and `src/routes/hashkey.ts` use `ethers` against the HashKey testnet (defaults: chainId `133`, RPC `https://testnet.hsk.xyz`, contract `0xE3b55a00445dEE1e330f81d113da2E4F28131B69`). `DEPLOYER_PRIVATE_KEY` is optional — read paths work without it; writes require it.

## Deploy

Railway + nixpacks. `nixpacks.toml` overrides install with `npm install --legacy-peer-deps` (a previous noble/hashes peer-dep conflict made plain install fail — the lockfile-bypass is intentional). `railway.toml` runs `node dist/index.js`. There is **no healthcheck** configured (was removed in `5b24b58`).

The server binds `0.0.0.0:$PORT` (default 3000).

## Conventions worth knowing

- `tsconfig.json` enables `strict` and `noUncheckedIndexedAccess` — array/object index access returns `T | undefined`. Expect to handle that explicitly.
- Many helpers use `(req as any).apiKey` / `(req as any).apiVersion` to attach per-request context — there's no shared Request type augmentation.
- A lot of "Sprint 3" comments mark intentional stubs (constitutional audit, mirror test, EAS attestation, ZKP). Don't "fix" them by hardcoding behavior — they're contract surfaces waiting for the real implementations.
- `package.json` declares `"main": "index.js"` but the actual entry is `dist/index.js` (built from `src/index.ts`). The `main` field is vestigial.

---

## HyperDAG Protocol Rules (from Sean — non-negotiable)

### Canonical data facts
- Supabase project: qnnpjhlxljtqyigedwkb (AITrinitySymphony)
- SOPHIA RepID: 10,000 AUTONOMOUS (cap). repid_earned: 19,157
- Canonical tier names: PROBATIONARY (0-499) / EARNING (500-999) / ESTABLISHED (1000-4999) / AUTONOMOUS (5000-7999) / VETERAN (8000-10000)
- Pythagorean Comma: 531441/524288 ≈ 1.013643
- φ = 1.61803398875, ε = 1e-8, BFT_THRESHOLD = 0.618
- REPID_HITL_GATE = 70, CONFIDENCE_GATE = 0.8

### Tier is database-derived (do NOT treat as a bug)

`repid_agents.tier` is overwritten on every INSERT/UPDATE by the Postgres
trigger `trg_sync_tier`. The application code in `src/engine/repid-update.ts`
and elsewhere writes `tier` in its UPDATE payloads, but that value is
immediately replaced by the trigger. The database is the source of truth for
tier; app-side writes are theater that the trigger overrides.

**THE TRIGGER CALLS THE TWO-ARGUMENT OVERLOAD, AND THIS PARAGRAPH USED TO SEND
YOU TO THE WRONG ONE.** There are two functions named `compute_tier`:

| signature | what it does | who calls it |
|---|---|---|
| `compute_tier(integer)` | pure score→tier ladder | **nothing in the live path** |
| `compute_tier(integer, uuid)` | score→tier, **then demotes on counterparty count** | `sync_tier()`, i.e. the trigger |

`sync_tier()` is `NEW.tier := compute_tier(NEW.current_repid, NEW.id)`. So the
one-argument version — the one this file told you to inspect for years — is not
the function that decides anything. Verified 2026-08-28 against prod.

**THE COUNTERPARTY GATE, which was documented nowhere.** The live overload
computes the base tier from score, then demotes:

- `VETERAN` requires **>= 2 unique counterparties**, else → `AUTONOMOUS`
- `AUTONOMOUS` requires **>= 2 unique counterparties**, else → `ESTABLISHED`
- `ESTABLISHED` / `EARNING` have a floor of 0 — no gate today

(`is_human = true` agents skip the demotion entirely and keep the base tier.)

This is deliberate anti-Sybil design, not a bug: a score farmed without real
counterparties cannot buy a top tier. It is also why **no agent is in
AUTONOMOUS or VETERAN** — measured 2026-08-28, the ESTABLISHED band holds 29
agents spanning 1000–10000, including one at the 10000 cap. If you see a
high-score agent in ESTABLISHED, that is the gate working. Do not "fix" it.

**`tier` CANNOT drift from `current_repid`, but it CAN lag counterparty count.**
This paragraph used to claim the trigger "guarantees `tier` can never drift",
which is true only of the score. The trigger is `BEFORE INSERT OR UPDATE **OF
current_repid**`, while the tier now also depends on
`count_unique_counterparties(id)` — a value that changes without any write to
`current_repid`. So an agent that earns its 2nd counterparty is **not promoted
until its score next moves**. MEASURED 2026-08-28: 0 agents currently sit at a
stale tier, so this is a live window, not a live wound. Re-check with:

```sql
select id, current_repid, tier as stored, compute_tier(current_repid, id) as now
from repid_agents where tier is distinct from compute_tier(current_repid, id);
```

To change tier names or thresholds you MUST update both together in one
migration:

1. The `compute_tier(integer)` Postgres function (returns the tier string)
2. The `repid_agents_tier_check` CHECK constraint (whitelist of allowed strings)

Updating only one will break every INSERT/UPDATE with a 23514 check_violation
because the trigger will produce a string the constraint rejects, or the
constraint will reject a value the trigger never produces.

Current canonical 5-tier scheme (as of 2026-05-08):
- PROBATIONARY (0–499)
- EARNING (500–999)
- ESTABLISHED (1000–4999)
- AUTONOMOUS (5000–7999)
- VETERAN (8000–10000)

Verify before touching: `SELECT pg_get_functiondef('compute_tier(integer)'::regprocedure);`

### Table rules (CLAUDE-RULE-5)
- Canonical agent table: repid_agents (NOT agent_repid — that is stale)
- Canonical score table: repid_score_events
- repid_standings view reads from agent_repid — this is a known bug, do not propagate it
- trinity_tasks.id is BIGINT not UUID
- NEVER assume column names — read schema first or ask

### Execution rules
- CLAUDE-RULE-1: Before ANY code/SQL/file change — show what exists first, ask "improve existing or build new?" Wait for answer
- CLAUDE-RULE-2: Never auto-execute unless Sean says GO. Ask "shall I proceed?" and wait
- CLAUDE-RULE-3: Fix ONLY the specific error named. Never refactor adjacent code
- CLAUDE-RULE-4: Truth over flattery. Say "I don't know" rather than fabricate
- CLAUDE-RULE-6: Shortest path to done. No busywork. Verify → execute → next

### Hard stops — never touch without explicit permission
- RepID scoring formula T=floor(2000×log₁₀...) — never appear in public docs
- ANFIS parameters — never in public docs
- Marco De Rossi's files in hyperdag-protocol: ERC8004SPEC.md, contracts/, test/, abis/
- Sprint-3 stubs (EAS, ZKP) — do not remove or "fix" passing stubs

### Deploy facts
- Railway project: **`repid-engine`** — its own project, 4 services: `repid-engine` (the API,
  repid-engine-production.up.railway.app), `receipt-indexer`, `proof-drain-worker`,
  `attestation-minter`.
  **Corrected 2026-07-30 (verified against the Railway dashboard).** This line previously read
  "Railway project: AITrinitySymphony", which is wrong and caused a wallet-custody master key to be
  configured in the wrong project. `AITrinitySymphony` is the separate *Trinity swarm* project
  (trinity-* agents, n8n, Flowise, py-brain/rust-brain, zkp-postcard, …) — it runs none of this
  repo's code. Set env vars for this repo on the `repid-engine` **service**, not as project-shared.
  **`attestation-minter` added to the list 2026-08-15**, observed on the dashboard; this line said
  "3 services" until then. It is **scheduled, not a server** — it shows a last-run status and a
  next-run time, and no public domain. **Its BUILD succeeds; its daily CRON RUN has failed since
  2026-08-17** — see the delivery-leg finding below (corrected 2026-08-29; this line previously
  said "failing every run", which reads as a build failure and sent one diagnosis down the wrong path).

  **Two claims in this paragraph were wrong, and both were negative findings — the kind that
  decays silently because anyone can add the missing thing without touching this file.**

  1. *"The string appears in no file in this repo"* — **false as of 2026-08-29.** It appears in a
     migration comment (naming the service as a possible external `SELECT *` consumer) and in
     `trinity-ecosystem` docs. A mention is not a source, so the substance survives; the sentence
     as written does not, and a reader who greps once and finds a hit now distrusts the rest.
  2. *"Do not assume it builds from this repo"* — **backwards for the other three.**
     `railway.toml` declares **no `startCommand`**, and its own comment says each service uses its
     own dashboard "Custom Start Command". So the other three demonstrably do build from here.

  **"There is no fourth" was FALSE, and it was the load-bearing half of the paragraph below
  [MEASURED 2026-08-29, from the service's own build log].** This repo has three *package.json*
  entrypoints — `start` (the API), `indexer` (receipt-indexer), `worker` (proof-drain-worker) —
  but a Railway Custom Start Command names a FILE, not an npm script, and `attestation-minter`
  runs **`node scripts/cron/mint-attestation.mjs`**. That file exists (11,659 bytes, with
  `scripts/cron/README.md` beside it). Enumerating npm scripts and concluding "no fourth" asked
  the wrong question of the right repo. The one thing here that mints EAS attestations,
  `easAnchorWorker`, runs **in-process inside the API server** (`src/index.ts`), not as a separate
  service, and its work queue is **empty** — no real proof is currently un-anchored. So nothing in
  this repo is waiting on this service.

  **The module-scope-Supabase hypothesis is REFUTED, and the service does not fail to build at all
  [MEASURED 2026-08-29 from the build log + live DB].** Both halves were wrong:

  1. **The build SUCCEEDS.** The log ends `exporting to docker image format` → `image push 378 MB`,
     deployment `Active`. Nothing here is a build failure. What goes red is the daily **cron run**.
  2. **The Supabase vars are PRESENT.** Docker's own `SecretsUsedInArgOrEnv` warnings name
     `SUPABASE_SERVICE_ROLE_KEY` and `BASE_SEPOLIA_PRIVATE_KEY` as `ARG`/`ENV` on this service, so
     it is not missing its environment. (Those warnings are also a real finding in their own right:
     a funded-wallet key is being baked into image layers.)

  **What actually fails — the delivery leg, since 2026-08-17.** `mint-attestation.mjs` buys a
  service from an eligible provider and needs the contract to reach `settled`. Measured in
  `service_contracts`:

      08-13 → 08-16   escrowed ✓  fulfilled ✓  settled ✓   (buyer_satisfaction_score 1)
      08-17 → 08-28   escrowed ✓  fulfilled ✗  settled ✗   status `resolved`,
                                                            dispute_verdict `provider_at_fault`

  Money escrows every run; **`fulfilled_at` is NULL on every run since 08-17**. The dispute path
  then fires correctly and the script exits 1 — the red run is honest reporting, not a bug in it.
  `erc8004_reputation_writes`: 91 total, last 2026-08-16, **0 in the last 7 days**. 29 providers
  are still eligible, so "no eligible provider" is NOT the cause.

  **Two suspects raised and killed, so nobody re-raises them.** `c38e5ac` (#434) landed 30 minutes
  before the first failure — perfect timing, but its diff touches only scoring, incentives and
  zkRepID, nothing in the contract or x402 path. `8fc370f` (#438) is the only commit in the window
  touching `src/services/x402-gate.ts`, but that change is shadow-only: it ignores its own return
  value, catches its own failures, and is inert unless `OWNER_CEILING_SHADOW_ENABLED` is set.

  **STILL UNVERIFIED: which delivery handler stopped responding.** Delivery is via "registered
  handler / cascade". Settling it needs the cron run's **Deploy Logs**, which are not readable from
  a sandboxed session (`railway.app` is proxy-denied). That is the one read left, and it is an
  operator's.

- Healthcheck: intentionally removed (do not re-add)
- Node: >=20.9.0
- All secrets injected via Railway env vars — never commit to code
- `AGENT_KEY_MASTER` (agent wallet custody, `src/services/agent-key-crypto.ts`) belongs ONLY on the
  `repid-engine` service. `receipt-indexer` (chain reads) and `proof-drain-worker` (EAS attestor key)
  must not have it — it decrypts every custodied agent wallet private key.
  `attestation-minter`: **half-settled 2026-08-29 — the assumption is dead, the presence question
  is not.** SETTLED: the signing key it actually uses is `BASE_SEPOLIA_PRIVATE_KEY`, read from the
  script's own source, so "an attestor must need `AGENT_KEY_MASTER`" is refuted — it does not.
  STILL UNVERIFIED: whether `AGENT_KEY_MASTER` is *also* set there. The build log names only
  `BASE_SEPOLIA_PRIVATE_KEY` and `SUPABASE_SERVICE_ROLE_KEY`, and **absence from that list is much
  weaker evidence than presence** — Docker flags only names matching its own sensitive-name
  heuristic, and the log surfaces build-time vars, not the full runtime set. Do not read "not in the
  log" as "not on the service". Read the service's Variables to close it.
