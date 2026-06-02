# Testing guide

How the test suites are wired, how to run them, and the env they expect. (Authored S-HARDEN, 2026-06-01.)

## TL;DR

```bash
npm test                     # unit + component — tests/**, jest.config.js (ignores tests/integration)
npm run test:integration     # tests/integration/** against live Supabase (runInBand); skips per-test if no creds
npx tsc --noEmit             # typecheck — must be 0 before requesting review
```

`npm test` and `npx tsc --noEmit` are the **merge gate**. If either regresses, fix it before review.

## The three jest configs (and the directory quirk)

There are **two** `*.test.ts` conventions and **three** configs — know which runner picks up your file:

| Config | Roots | What runs | Notes |
|---|---|---|---|
| `jest.config.js` (`npm test`) | `tests/` (+ `src/hal/lib/__tests__`) | unit + component | **`testPathIgnorePatterns` excludes `tests/integration/`** |
| `jest.integration.config.js` (`npm run test:integration`) | `tests/integration/` | live-DB integration | `--runInBand`, 30 s/test, mocks `@xenova/transformers` |
| `tests/e2e/jest.e2e.config.js` (`npm run test:e2e`) | `tests/e2e/` | full e2e | `--runInBand --forceExit` |

> **Gotcha:** `src/**/__tests__/*.test.ts` is compiled into `dist/` but only `src/hal/lib/__tests__` is in the unit roots — other `__tests__` dirs are NOT run by `npm test`. Put new unit tests under `tests/` to be sure they execute. Running bare `npx jest` is ambiguous (a `jest` key in `package.json` competes with `jest.config.js`) — always pass `--config`.

## Integration tests & credentials

Integration tests hit **live Supabase** (mostly read-only; tagged synthetic inserts are cleaned up on teardown) and **skip cleanly when creds are absent** — that's the intended posture, so an env-less run is green, not failing.

- They read `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (service-role; bypasses RLS). The committed `.env` is a **dummy for boot-without-DB** — its values are empty.
- To run them for real, source keyed creds first:
  ```bash
  set -a; source <(grep -E '^(SUPABASE_URL|SUPABASE_SERVICE_KEY)=' ../repid-engine-cc-crosscheck/.env); set +a
  npm run test:integration
  ```
- Tests that need a live DB use `const liveDescribe = URL && KEY ? describe : describe.skip;` so they self-skip rather than fail.

## What the S-HARDEN integration tests cover

| File | Layer exercised | Posture |
|---|---|---|
| `tests/integration/hal-e2e.test.ts` | `evaluate()` over good/bad/hallucination | **pure** — no DB/network; asserts the pipeline *contract* (score bounds, veto consistency, determinism, trust-score inversion) and documents the known strictness-1 blindness (see CALIBRATION_REPORT) |
| `tests/integration/provider-routing.test.ts` | `routeRequest()` ANFIS/tiered router | **mocked** db + caps; asserts SLM low-complexity routing, `excludeProviders` honored, valid decision shape |
| `tests/integration/audit-chain-integrity.test.ts` | hash-chain construction + live verify | **offline** algorithm/tamper-detection (reproduces the trigger's `sha256(prior‖content)` construction) **+ env-gated** live recompute (`breaks === 0`) |

## Stress / load (`scripts/stress/`)

```bash
npx ts-node scripts/stress/hal-load-test.ts [N]   # N concurrent HAL evals; reports p50/p95/p99, errors, determinism
```

See `scripts/stress/STRESS_REPORT.md` for the latest run (50/500-wide PASS, DB-pool and rate-limiter audits).

## Audit-chain verification (`scripts/audit/`)

```bash
npx ts-node scripts/audit/verify-chain.ts --table tool_call_log --json   # VALID / CHAIN_BREAK
```

> The recompute runs **server-side** (Postgres `digest()`), so it's byte-identical to the trigger. A JS reproduction of `to_jsonb` serialization would drift — don't. Note `verify-chain.ts` reaches the DB via the `exec_sql` RPC, which is **RLS-subject**; for RLS-protected tables (e.g. `tool_call_log`) verify via the service-role/pooler path (the integration test does this) or MCP.

## Conventions

- **Determinism:** no `Date.now()`/`Math.random()` in assertions; HAL extractor is pure, so identical input ⇒ identical score (tested).
- **Truth over green:** don't assert a threshold the code can't meet (e.g. "good > 0.7" on the blind extractor). Assert the invariant that *is* true and document the gap — see `hal-e2e.test.ts`.
- **Flag defaults stay safe:** new behavior is opt-in (`HAL_SCORE_V2`, `TOOL_CALL_LOGGING`, `CAPABILITY_FILTER`, `HAL_STRICTNESS`) — tests must pass with flags at their default (off).
