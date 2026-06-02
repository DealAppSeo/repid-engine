# Contributing to repid-engine

`repid-engine` is the behavioral-reputation scoring backend for the HyperDAG Protocol Trust\* ecosystem — an Express + TypeScript API over Supabase that scores agent reputation (RepID), runs the HAL hallucination check, and anchors a hash-chained audit + ZKP/EAS attestation pipeline. **Private / proprietary** — do not redistribute. This guide gets a new contributor productive.

## 1. Local setup
```bash
git clone <repo> && cd repid-engine
npm install --legacy-peer-deps      # REQUIRED — plain `npm install` fails (nixpacks lockfile bypass)
cp .env .env.local                  # a dummy .env is committed for boot-without-DB; fill real creds locally
```
**Env vars** (`src/config.ts` throws at boot without the first two):
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — required. Get from Sean / Railway (project `qnnpjhlxljtqyigedwkb`).
- Optional: `GROQ_API_KEY` / `CEREBRAS_API_KEY` / `FIREWORKS_API_KEY` (HAL cross-LLM, strictness 2), `DATABASE_URL` (Supavisor pooler `:6543`, direct-pg hot paths), `DEPLOYER_PRIVATE_KEY` (on-chain writes — read paths work without it).
- Real secrets come from Railway env vars at deploy. **Never commit secrets.**
```bash
npm run dev      # ts-node src/index.ts (binds 0.0.0.0:$PORT, default 3000)
```

## 2. Run the gates (both must pass before any PR)
```bash
npx tsc --noEmit                          # must be 0 errors (strict + noUncheckedIndexedAccess)
npm test                                  # jest (uses --config jest.config.js --forceExit)
```
- **Jest quirk:** the repo has both `jest.config.js` and a `jest` key in `package.json`, so a bare `npx jest` errors with "multiple configurations". Always use `npm test` or `npx jest --config jest.config.js`.
- Jest only runs `tests/*.test.ts` (`roots` is pinned there). `src/**/__tests__/*.test.ts` exist but are **not** run by `npm test` — put new tests under `tests/`.
- Baseline to beat: **0 tsc errors, ~1278 passing tests.** A PR may not worsen either.
- Integration tests are a **separate** runner: `npm run test:integration` (live Supabase, self-skips without creds). Full testing guide: [`docs/TESTING.md`](docs/TESTING.md).

## 2a. Common operational how-tos

**Calibrate / interpret HAL scores.** `hal_score` is a **RISK** score in `[0,1]` (high = likely hallucination), veto at `≥ threshold`. The strictness-1 extractor is *blind* (it does not separate good from bad — measured AUC ~0.36); real discrimination is the strictness-2 cross-LLM fact-check path. Don't "fix" a compressed score by retuning the extractor — see [`scripts/hal-eval/CALIBRATION_REPORT.md`](scripts/hal-eval/CALIBRATION_REPORT.md). A trust-oriented `0–100` score is available via `computeTrustScore()` (`src/hal/lib/score.ts`), gated for rollout behind `HAL_SCORE_V2`. To re-run the calibration probe: `npx ts-node scripts/hal-eval/calibration-test.ts` (set `HAL_S2=1` to also exercise the fact-check path).

**Add a new LLM provider.** Implement a `ProviderAdapter` (`src/providers/<name>.ts`, copy an existing one — `groq.ts` is the simplest), register it in the right tier array in `src/providers/router.ts`, add its API key to Railway env, and add it to the matrix in [`docs/PROVIDERS.md`](docs/PROVIDERS.md). The HAL fact-check quorum (groq + cerebras + fireworks) is configured separately — see PROVIDERS.md before changing it.

**Verify the audit hash-chain.** `npx ts-node scripts/audit/verify-chain.ts --table tool_call_log --json` → `VALID` / `CHAIN_BREAK`. The recompute runs server-side (byte-identical to the trigger); `verify-chain.ts`'s `exec_sql` path is RLS-subject, so for RLS-protected tables verify via the service-role/pooler path (`tests/integration/audit-chain-integrity.test.ts`) or MCP.

**Read the tool-call audit log.** Decision/tool invocations are appended to the hash-chained `tool_call_log` when `TOOL_CALL_LOGGING=true` (default off — `src/utils/tool-call-logger.ts`, wired into the HAL pipeline and ANFIS router). It stores `tool_output_hash` (sha256), not raw output. Query it with the service-role key or the postgres pooler (RLS denies anon/authenticated).

## 3. Branch naming & PR process
- **Branch:** `feat/<author>-YYYY-MM-DD-<short-description>` (e.g. `feat/cc-2026-06-01-f2-spoofing-fix`).
- **Gate every change on tsc + jest** — if either regresses, fix it before requesting review.
- **Verify flag defaults stay safe.** New behavior must be opt-in:
  - `HAL_STRICTNESS` → default `1` (extractor); fact-check only at `=2`.
  - ZKP anchoring → dry-run by default (`persist ?? false`); on-chain send is key-gated (Sean only).
  - `WRITER_DIRECT_APPLY` → default `true` (existing direct-apply preserved).
- **Merge style:** squash for tooling/diagnostics; `--no-ff` for feature/design branches so history stays legible.
- **No self-merge** — a second reviewer (Cowork) co-signs. **No Railway deploy from a PR** — Sean deploys after reviewing the merged `main`.
- **Schema changes are design-only in-repo:** put migration SQL under `migrations/` or `scripts/` with a per-table rollback line; **Sean applies it in Supabase** (the repo never auto-runs DDL).

## 4. Architecture — the 5-layer stack
1. **Routes (`src/routes/`)** — Express API. The pipeline is `helmet → cors → json → SQL-keyword sanitizer → authMiddleware → rateLimit → versioning → routers`. Mount order matters (`challengeRouter` before `scoreRouter`). Entry: `src/index.ts`.
2. **Engine / scoring (`src/engine/`, `src/scoring/`)** — `updateRepId` / `runScoreEvent` turn `(prompt, answer) + agent state` into a HAL evaluation, a RepID delta (vesting-aware), a `repid_score_events` row, an agent update, and a ZK-proof trigger. Tier is **DB-derived** (the `trg_sync_tier` trigger overwrites app-side `tier` from `current_repid` — don't fight it).
3. **Layers (`src/layers/`)** — pure-ish scoring math: decay, prediction, challenge, ecosystem-need, constitutional-audit. Several are intentional "Sprint 3" stubs (always-pass) — don't hardcode behavior into them.
4. **HAL (`src/hal/`)** — the hallucination scorer. Extractor path (5 linguistic signals: harm/epistemic/evidence/scope/certainty) at strictness 1; cross-LLM fact-check (groq + cerebras + fireworks) at strictness 2. Gated by `HAL_STRICTNESS` (+ `HAL_ENRICHMENT_ENABLED`).
5. **Attestation (`src/zkp/`, audit chain, `src/engine/hashkey-chain.ts`)** — hash-chained audit trail (`verify-chain.ts`), ZKP merkle aggregation + EAS/ERC-8004 anchoring, HashKey on-chain. Most on-chain writes are Sean/key-gated; ZKP/EAS have always-on stubs.

RLS: all 545 public tables have RLS enabled; writers use the **service-role** key or the **postgres pooler** role (both bypass RLS) — anon/authenticated are denied by default. Don't add anon write paths.

## 5. What NOT to touch (without explicit review)
- **Marco De Rossi's files in `hyperdag-protocol`** (`ERC8004SPEC.md`, `contracts/`, `test/`, `abis/`) — off-limits.
- **`constitutional-agent-base.js` / the swarm agent loop** (in `trinity-symphony-shared`) — review first; it's actively rewritten and overlaps in-flight branches.
- **The RepID scoring formula and ANFIS parameters** — never put them in public-facing docs.
- **Sprint-3 stubs** (EAS / ZKP / mirror test / constitutional audit) — don't "fix" passing stubs; they're contract surfaces.
- **`compute_tier` / tier CHECK constraint** — change both together in one migration or every INSERT 23514-fails.

## 6. Key files (start here)
| File | What |
|---|---|
| `src/routes/route.ts` | `/v1/llm/complete` provider routing + auth (agent_id binding — the F2 fix lives here) |
| `src/scoring/pipeline.ts` | `runScoreEvent` — HAL → delta → score-event → agent update; `HAL_STRICTNESS` routing |
| `src/engine/repid-update.ts` | `updateRepId` — the canonical scoring sequence |
| `src/services/authority-math.ts` | `computeAuthority` = `min(R, 100·√S_usd)` (anti-whale stake authority) |
| `src/hal/lib/evaluate.ts` / `extract.ts` | HAL evaluation + the 5 extractor signals |
| `scripts/audit/verify-chain.ts` | walks the hash-chained audit trail → VALID / CHAIN_BREAK |
| `scripts/verify/crosscheck.ts` | `verify:crosscheck` — re-derives load-bearing claims (authority/RLS/HAL/guards/swarm) |
| `CLAUDE.md` | the canonical rules (tiers, table names, hard-stops) — read it |

Questions → ask Sean or Cowork before changing scoring, the sync, the formula, or anything in §5.
