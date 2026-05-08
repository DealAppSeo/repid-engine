# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`repid-engine` is the proprietary behavioral reputation scoring backend for the HyperDAG Protocol Trust* ecosystem (`trustrepid.dev` / `hyperdag.dev`). It is an Express API that mutates agent reputation (`repid`) scores in Supabase and stubs out an EAS / ERC-8004 / ZKP attestation pipeline.

Private, proprietary — not for public distribution.

## Commands

```bash
npm install --legacy-peer-deps   # required — plain `npm install` will fail (matches nixpacks.toml)
npm run dev                       # ts-node src/index.ts
npm run build                     # tsc → dist/
npm start                         # node dist/index.js (production entry, also Railway start command)
npm test                          # jest, runs everything under tests/
npx jest tests/repid-score.test.ts            # single file
npx jest -t "<test name substring>"           # single test by name
```

`SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are required at boot (`src/config.ts` throws if missing). A dummy `.env` is committed for local boot-without-DB; real credentials come from Railway env vars at deploy.

## Test layout — important quirk

There are **two** test directory conventions in this repo:

- `tests/*.test.ts` — the only location Jest actually runs (`jest.config.js` pins `roots: ['<rootDir>/tests']`).
- `src/**/__tests__/*.test.ts` — exists for several layers (`challenge-scoring`, `decay`, `prediction-scoring`) but is **not picked up by `npm test`**. These files also get compiled into `dist/` because `tsconfig.json` only excludes the top-level `tests/` directory, not `__tests__` subfolders.

If you add tests, put them under `tests/` to make them run. If you touch `__tests__` files, decide explicitly whether to relocate or extend the jest `roots`.

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
2. **Constitutional audit** (`src/layers/constitutional-audit.ts`) — LASSO rule selection + ANFIS fuzzy scoring + mirror test + EAS attestation. **Currently stubs that always pass with score 1.0**; real implementation is "Sprint 3". The audit assigns a `halMode` (1–7) gate.
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
trigger `trg_sync_tier`, which calls `compute_tier(current_repid)`. The
application code in `src/engine/repid-update.ts` and elsewhere writes `tier`
in its UPDATE payloads, but that value is immediately replaced by the trigger.
The database is the source of truth for tier; app-side writes are theater
that the trigger overrides.

This is intentional architecture, not a bug. It guarantees `tier` can never
drift from `current_repid`.

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
- Railway project: AITrinitySymphony
- Healthcheck: intentionally removed (do not re-add)
- Node: >=20.9.0
- All secrets injected via Railway env vars — never commit to code
