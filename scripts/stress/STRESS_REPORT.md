# S-HARDEN Phase 5 — Stress / Resilience Report

Date: 2026-06-01 · branch `feat/cc-2026-06-02-system-hardening`

## 1. HAL evaluation under concurrency (`scripts/stress/hal-load-test.ts`)

In-process load test firing N concurrent `evaluate()` calls (strictness 1, the
production default extractor path — no providers, no DB). Run: `npx ts-node scripts/stress/hal-load-test.ts [N]`.

| N concurrent | completed | errors | wall | throughput | latency p50 / p95 / p99 / max | distinct scores |
|---|---|---|---|---|---|---|
| 50  | 50/50   | 0 | 4 ms  | ~12.5k/s | 2 / 2 / 3 / 3 ms   | 1 |
| 500 | 500/500 | 0 | 13 ms | ~38k/s   | 5 / 9 / 11 / 13 ms | 1 |

**Verdict: PASS.** The strictness-1 extractor is pure/synchronous — it sheds no
work and stays **deterministic under load** (1 distinct score for identical input =
no shared-state corruption, no race). Latency is sub-15 ms even at 500-wide.

> Caveat — scope of this test: it exercises the **extractor** path only (the hot
> path for every request). The strictness-2 **fact-check** path makes network calls
> to groq/cerebras/fireworks and is rate-/quota-bound *by the providers*, not by this
> engine; its concurrency ceiling is the provider quota, not CPU. Burst behaviour of
> that path is covered by the provider-fragility finding in Phase 1's CALIBRATION_REPORT.

## 2. DB connection pool

App pool (`src/db/direct-pg.ts`): `max=5`, `idleTimeout=30s`, `connectionTimeout=5s`,
`statement_timeout=query_timeout=10s`, on the `:6543` transaction pooler. Bounded and
self-healing (idle-client errors logged, never crash; next query reconnects).

Live `pg_stat_activity` (project `qnnpjhlxljtqyigedwkb`, current DB):

| max_connections | total | active | idle | idle_in_transaction |
|---|---|---|---|---|
| 60 | 13 | 3 | 8 | **0** |

**Verdict: HEALTHY.** ~22% utilization, comfortable headroom. **Zero
`idle in transaction`** = no leaked/abandoned transactions holding connections (the
classic pool-exhaustion failure mode). With per-instance `POOL_MAX=5` against a 60-slot
server, ~12 app instances could run before saturating — well above current fleet size.

## 3. Rate limiter — IPv6 evasion (GMPD) audit + fix

**Audited two layers:**

- `express-rate-limit` per-route limiters in `src/index.ts` (`registrationLimiter`,
  `scoreLimiter`, `externalScoreLimiter`): **SAFE** — already key via
  `ipKeyGenerator(req.ip)`, which masks IPv6 to /64.
- Custom tiered middleware `src/middleware/rate-limit.ts` (`rateLimitMiddleware`, the
  global `/api/v1/*` gate): **BUG FOUND** — the IP-fallback bucket keyed on the *full*
  address (`ip:${ip}`). For IPv6 that's the /128, so a client holding a standard /64
  allocation could rotate host bits for a fresh bucket every request = unbounded limit
  evasion (GMPD).

**Fix applied (this branch):** added `normalizeIpForKey()` — IPv4 keyed as-is, IPv6
masked to its /64 prefix (expands `::`, strips `::ffff:` v4-mapped prefix and `%zone`),
matching the express-rate-limit limiters. Wired into `resolveIdentity`'s IP fallback.
7 unit tests added (`tests/rate-limit.test.ts`), incl. the key invariant: every address
in one /64 collapses to a single bucket. Behaviour for IPv4 and for keyed/agent/BYOK
buckets is unchanged. tsc 0, jest 18/18 on the suite.

## Summary

| Check | Result |
|---|---|
| HAL 50/500 concurrent | PASS — 0 errors, deterministic, <15 ms p99 |
| DB pool / connection leaks | HEALTHY — 13/60, 0 idle-in-txn |
| Rate limiter IPv6 GMPD | **BUG FOUND + FIXED** (tiered middleware), express limiters already safe |
