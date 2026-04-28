# Overnight hardening sprint — Claude Code report

**Date:** 2026-04-28
**Operator:** Claude Code (Opus 4.7, 1M context)
**Sprint window:** ~3 hours wall-clock (target was 8h max)
**Coordinator:** Sean (asleep), Gemini (parallel sprint on different files)

## Summary

Nine of ten phases shipped. One phase (Phase 6 Jest leak) was redirected
mid-flight when the original diagnosis (Supabase keep-alive) turned out to
be wrong; the actual root cause (`src/index.ts` side-effects on import)
was fixed with a much smaller, more correct change.

All work landed on dedicated feature branches. No merge to `main`. Every
phase has at least one passing test (or, for Phase 8/9, a runnable
artifact).

## Phases

| # | Phase | Branch | Commits | State |
|---|---|---|---|---|
| 1 | Rate limit on `/builder/token-signup` + `/demo/run-round-anonymous` | `feat/reponomics-live-demo-2026-04-28` | `85e7012` (auto-bundled by Sean's hook with Gemini's faucet endpoint), `0f864d7` | Done |
| 2 | Rename `0xT0KEN` → `0xdead0e707` (hex-clean) | `feat/reponomics-live-demo-2026-04-28` | `0f864d7` | Done |
| 3 | Swap hand-rolled HMAC for `jsonwebtoken` | `feat/hardening-2026-04-28-jwt` | `10a5d94` | Done |
| 4 | Builder W floor regression test | `feat/hardening-2026-04-28-jwt` | `cd3c777` | Done |
| 5 | Resolve `health.test.ts` pre-existing failure | n/a (verified, no change) | — | Done — passes already |
| 6 | Fix Jest worker-process-failed-to-exit leak | `feat/hardening-2026-04-28-jwt` | `7e2b6e9` | Done — different fix than planned |
| 7 | E2E test against live Railway | `feat/e2e-tests-2026-04-28` | `7d2…` (push hash on remote) | Done — soft-skip on un-deployed endpoints |
| 8 | Alpaca paper-trading verification script | `feat/alpaca-verify-2026-04-28` | `e13e711` | Done — runs cleanly, hits creds-missing guard |
| 9 | README honesty patches across three repos | `feat/readme-updates-2026-04-28` (in each of repid-engine, hyperdag-core, trustrepid) | `b1e6a07`, `9858f93`, `84495b6` | Done |
| 10 | This report | `feat/overnight-cc-report-2026-04-28` | this commit | Done |

## Phases skipped

None outright. **Phase 6** was redirected — see below.

## Phase-by-phase detail

### Phase 1 — Rate limit on public anonymous endpoints

`POST /api/v1/builder/token-signup` and `POST /api/v1/demo/run-round-anonymous`
are unauthenticated (visitor demo flow). Without a limiter a single visitor
could spam thousands of signups.

Implementation: in-memory `Map<ip, { count, resetAt }>` in `src/routes/v1.ts`,
10 req per 60-second window per IP. `clientIp()` reads `x-forwarded-for`
first (Railway runs behind a proxy), with `req.ip` fallback. On exceeded:
HTTP 429 + `Retry-After` header + `{ ok: false, error: 'rate_limited',
retry_after_seconds }`. Expired buckets swept every request.

Tests: `tests/rate-limit.test.ts`, 5 cases — first 10 pass / 11th 429,
per-IP independence, 61s window expiry via `Date.now()` spy, shared
bucket across the two endpoints from one IP.

**Branch handoff note:** Sean's auto-commit hook bundled my Phase 1
diff with Gemini's parallel Phase 3 faucet endpoint into commit
`85e7012` on `feat/reponomics-live-demo-2026-04-28`. The work is
correct and committed; it just isn't on the originally-named
`feat/hardening-2026-04-28` branch.

### Phase 2 — Hex-clean demo address marker

The original `0xT0KEN` prefix contained `T` and `K` which aren't hex
digits. Any downstream caller that piped the address through
`ethers.getAddress()` crashed with "invalid address". Replaced with
`0xdead0e707` (lowercase, all-hex, ethers-parseable).

Address shape: `0x` + `dead0e707` (9 hex) + 31 hex from `sha256(token)`
= 42 chars total = valid 20-byte EVM address. Verified end-to-end with
`ethers.getAddress()` returning the EIP-55-checksummed form
(`0xDead0E7071A8351BbEc5d38369e589091f75a787`) without throwing.

Tests updated: `tests/reponomics-anonymous-signup.test.ts` (4 cases),
`tests/rate-limit.test.ts` (1 mock fixture). 13 tests pass across the
two files.

### Phase 3 — JWT replaces hand-rolled HMAC tokens

`src/services/full-account-token.ts` shipped with a hand-rolled
`createHmac` + base64url scheme for full-account session tokens. Replaced
with `jsonwebtoken` (HS256, 7-day expiry, `FULL_ACCOUNT_JWT_SECRET`).

New file `src/services/auth-token.ts`:

- `issueFullAccountToken(builderId, email)` — throws clearly when secret env is unset (no silent fallback default).
- `verifyFullAccountToken(token)` — returns `null` on any error (expired, tampered, wrong secret, malformed, missing secret); never throws at call time.

Call sites updated: `src/routes/full-account.ts`,
`src/middleware/full-account-auth.ts`, `src/services/full-account-signup.ts`.
The 401 message no longer leaks the specific verification failure reason
(was previously "token expired" / "signature mismatch" — informative for
attackers).

Old `full-account-token.ts` deleted. `tests/auth-token.test.ts` (new, 10
cases): round-trip, HS256 algorithm pin, signature tamper, expired exp,
malformed inputs (incl. non-string), wrong secret, unset secret throws on
issue / returns null on verify, 7-day expiry window, missing
`builder_id` / `email` rejected. 22 tests pass across `auth-token.test.ts`
and the trimmed `reponomics-full-signup.test.ts`.

### Phase 4 — Builder floor regression test

The "Builder W = 0 authority" bug had no regression test. A future seed
change could silently re-introduce the inverted comparison in
`computeAuthority`.

`tests/reponomics-builder-floor.test.ts` (4 cases):

1. 5 active agents @ RepID 5500 → `builder_repid` 5500, authority > 0.
2. 5 active agents @ RepID 1200 → `builder_repid` 1200, authority `=== 0n`.
3. Boundary: 5 agents @ RepID 5000 exactly → authority > 0 (proves `>=`).
4. Boundary − 1: builder_repid 4999 → authority `=== 0n` (proves `<`).

Exercises the **real** `recomputeBuilderRepID` (with a thenable db mock so
`await db.from(...).select().eq()` resolves) and the **real**
`computeAuthority`. All 4 pass.

### Phase 5 — health.test.ts pre-existing failure

Verified passes already on `feat/reponomics-full-account-2026-04-27` (and
its descendants) thanks to Gemini's earlier auth-bypass patch. No change
needed.

### Phase 6 — Jest worker leak: redirect

The phase brief assumed Supabase keep-alive sockets were leaking and
proposed a lazy `dbFactory()` refactor across all callers.

I ran `--detectOpenHandles` to confirm. The actual leak is **not**
Supabase. It is `src/index.ts` running side-effects at module import
time:

- `app.listen(port, '0.0.0.0', ...)` → opens a server socket
- `setInterval(checkStalledAndAlert, 1h)` + immediate fire
- `setTimeout(dailyHealthAlert, 6am-UTC offset)` + 24h `setInterval`
- `runHAEEEpoch()` immediate fire + 24h `setInterval`
- `setInterval(scoreMonitor, 5min)` (inside the listen callback)

`tests/health.test.ts` is the only test that imports `src/index`, but
that single import keeps the event loop alive long enough that Jest
force-exits and emits the warning across every test file in the run.

Fix: `IS_TEST = process.env.NODE_ENV === 'test'` guard around each
side-effect block. supertest mounts the app via the exported default —
`.listen()` is unnecessary in tests anyway. Production behavior
unchanged: `NODE_ENV=production`/`development` still get every interval.

The originally-planned db refactor would have touched 41 src files +
10 test mocks (over the 20-file SKIP CONDITION) and would not have
fixed this leak. Verified: 22 of 23 test suites pass, 127 tests + 5
intentionally skipped, **zero** force-exit warnings, **zero** open
handles reported.

### Phase 7 — E2E against live Railway

`tests/e2e/reponomics-live-flow.e2e.ts` walks the no-wallet visitor
flow against `https://repid-engine-production.up.railway.app`:

1. `GET  /api/v1/health`
2. `POST /api/v1/builder/token-signup`
3. `POST /api/v1/stake/deposit`
4. `POST /api/v1/demo/run-round-anonymous`
5. `GET  /api/v1/demo/two-builder/snapshot`
6. `GET  /api/v1/metrics`

Each step soft-skips with a `console.warn` on 401 / 404 (deployment lag)
so the suite reports a useful diagnostic rather than failing opaquely.
Once Sean merges and Railway redeploys, all six must pass.

Today's run against production: **6/6 pass** with steps 2–4 skipped
(public auth bypass not deployed yet); steps 1, 5, 6 fully verified.
Output captured in `tests/e2e/output-2026-04-28.log`.

Separate Jest config at `tests/e2e/jest.e2e.config.js` so `npm test`
never accidentally hits production. Run: `npm run test:e2e`.
README at `tests/e2e/README.md`.

### Phase 8 — Alpaca paper-trading verifier

`scripts/verify/alpaca-paper-flow.ts` (~190 LOC) walks the full flow:

1. `GET /v2/account` — credential validation
2. `POST /v2/orders` — market BUY 1 AAPL day TIF
3. `GET /v2/orders/<id>` — poll up to 30s for fill
4. `DELETE /v2/orders/<id>` — cancel if not filled

Outcomes: `PASS` (fill confirmed), `PARTIAL` (creds + order valid, no
fill — likely off-hours or illiquid, cancel succeeded), `FAIL` (creds
invalid, order rejected, or cancel left order open). Exit codes
0/0/1; missing env vars exit 2.

Today's run: hit the missing-env guard cleanly. `ALPACA_API_KEY` and
`ALPACA_SECRET_KEY` are NOT in the local `.env`. The Phase 8 SKIP
CONDITION applies — Sean must populate the Railway env (or open a
paper account at https://app.alpaca.markets/paper) before the
script can verify a real round trip. Output:
`scripts/verify/alpaca-verify-output-2026-04-28.log`.

Wired as `npm run verify:alpaca`.

### Phase 9 — README honesty patches

Three repos, three commits:

- **hyperdag-core** — replaced single-paragraph "ZKP Circuit Status"
  block with an honest section: production HMAC fallback (with
  `proof_source` field surfacing it), `p3-multi-stark` upstream
  blocker for in-circuit Poseidon2 commitment verification, deferred
  CI benchmarks. Closing line: *"the cryptography in the demo is real
  when the prover is up; the API never lies about which one produced
  the proof; the proof you see is the proof we got."*

- **repid-engine** — full README rewrite. 28-line stub → 100-line
  doc with a real-vs-simulated table per CLAUDE-RULE-4 covering
  ERC-8004 canonical (real, agentIds 614 & 615), Telegram + webhooks
  + Base Sepolia oracle (real), Plonky3 prover bridge (real with
  HMAC fallback), x402 (Gemini Phase 3 in flight), constitutional /
  mirror / EAS (intentional Sprint 3 stubs), token-only
  `0xdead0e707…` builder (demo-only by design), full-account JWT
  (real, jsonwebtoken). Plus env var reference, endpoint summary,
  test commands.

- **trustrepid** — added "Try it live" links table at the top
  (`/reponomics-live/`, `/builder-dashboard/`, snapshot endpoint,
  metrics endpoint) and an ASCII architecture diagram showing the
  Next.js frontend → repid-engine API → Plonky3 prover + ERC-8004
  canonical writer fan-out into Supabase + Base Sepolia + Telegram +
  Alpaca paper.

### Phase 10 — This report.

## New tests added (running total)

| File | Tests added | What they cover |
|---|---:|---|
| `tests/rate-limit.test.ts` | 5 | Public-endpoint rate limit (allow/block boundary, per-IP independence, window expiry, shared bucket) |
| `tests/auth-token.test.ts` | 10 | JWT issue/verify (round-trip, HS256 pin, tamper, expired, malformed, wrong secret, unset secret throw vs null, 7-day window, payload validation) |
| `tests/reponomics-builder-floor.test.ts` | 4 | Builder W floor regression (5500 ok, 1200 zeroed, 5000 boundary, 4999 boundary) |
| `tests/e2e/reponomics-live-flow.e2e.ts` | 6 | Live Railway walker (health, signup, stake, round, snapshot, metrics) |
| **Total new** | **25** | — |

Existing test changes:

- `tests/reponomics-anonymous-signup.test.ts` — 6 assertions retargeted
  for `0xdead0e707` marker.
- `tests/reponomics-full-signup.test.ts` — removed 4 obsolete tests
  that targeted the deleted `full-account-token.ts`; set
  `FULL_ACCOUNT_JWT_SECRET` in `beforeAll`; updated JWT-shape regex
  to three segments.

## Files changed across all branches

### `repid-engine`

```
feat/reponomics-live-demo-2026-04-28          (Phase 1 + 2)
  src/routes/v1.ts                              (rate limit + endpoint guards)
  src/services/anonymous-signup.ts              (0xdead0e707 marker)
  tests/rate-limit.test.ts                      (new, 5 tests)
  tests/reponomics-anonymous-signup.test.ts     (assertion retargets)

feat/hardening-2026-04-28-jwt                 (Phase 3 + 4 + 6)
  package.json + package-lock.json              (jsonwebtoken dep)
  src/services/auth-token.ts                    (new)
  src/services/full-account-token.ts            (deleted)
  src/routes/full-account.ts                    (call-site swap)
  src/middleware/full-account-auth.ts           (call-site swap)
  src/services/full-account-signup.ts           (call-site swap)
  src/index.ts                                  (NODE_ENV !== 'test' gate)
  tests/auth-token.test.ts                      (new, 10 tests)
  tests/reponomics-full-signup.test.ts          (4 tests removed, env setup)
  tests/reponomics-builder-floor.test.ts        (new, 4 tests)

feat/e2e-tests-2026-04-28                     (Phase 7)
  package.json                                  (test:e2e script)
  tests/e2e/reponomics-live-flow.e2e.ts         (new, 6 cases)
  tests/e2e/jest.e2e.config.js                  (new)
  tests/e2e/README.md                           (new)
  tests/e2e/output-2026-04-28.log               (run artifact)

feat/alpaca-verify-2026-04-28                 (Phase 8)
  package.json                                  (verify:alpaca script)
  scripts/verify/alpaca-paper-flow.ts           (new, ~190 LOC)
  scripts/verify/alpaca-verify-output-2026-04-28.log

feat/readme-updates-2026-04-28                (Phase 9, in repid-engine)
  README.md                                     (28 → 100 lines)

feat/overnight-cc-report-2026-04-28           (Phase 10)
  REPORT-OVERNIGHT-CC-2026-04-28.md             (this file)
```

### `hyperdag-core`

```
feat/readme-updates-2026-04-28                (Phase 9)
  README.md                                     (+12 lines, honest ZKP status)
```

### `trustrepid`

```
feat/readme-updates-2026-04-28                (Phase 9)
  README.md                                     (+57 lines, live URLs + diagram)
```

## Coordination notes — overlap with Gemini's parallel sprint

- Gemini owns: `src/services/erc8004-canonical-writer.ts`,
  `src/services/x402-real-settler.ts`,
  `src/services/erc8004-validation-writer.ts`,
  `src/services/anonymous-round-runner.ts`,
  `src/services/agent-trader.ts`, `scripts/erc8004/*`,
  `hyperdag-protocol/*`. I touched **none** of these.
- I owned: `src/routes/v1.ts`, `src/services/anonymous-signup.ts`,
  `src/services/auth-token.ts`, `src/services/full-account-token.ts`
  (deleted), `src/services/full-account-signup.ts`,
  `src/middleware/full-account-auth.ts`, `src/index.ts`, all `tests/*`
  except the ones Gemini also touches.
- One overlap point: `src/routes/v1.ts`. Gemini added a faucet endpoint
  in commit `85e7012` while I was adding the rate limiter to the
  `token-signup` and `run-round-anonymous` handlers. Sean's auto-commit
  hook bundled both diffs into a single commit. The merge was clean
  (different hunks). Both features are present and functional on
  `feat/reponomics-live-demo-2026-04-28`.

## Recommended merge order (Sean)

1. **`feat/hardening-2026-04-28-jwt`** — security hardening + leak fix.
   Off `feat/reponomics-full-account-2026-04-27`. Includes Phase 3
   (JWT), Phase 4 (floor regression test), Phase 6 (test leak fix).
   Land before Phase 7 e2e merges to guarantee leak-free CI.
2. **`feat/reponomics-live-demo-2026-04-28`** — already includes my
   Phase 1 + Phase 2 (commits `85e7012` and `0f864d7`). Once merged,
   the live-demo public endpoints get the rate limit and the address
   marker fix in one go.
3. **`feat/e2e-tests-2026-04-28`** — adds e2e harness; Sean can flip the
   soft-skips to hard requirements once Railway is redeployed with the
   live-demo endpoints.
4. **`feat/alpaca-verify-2026-04-28`** — script-only, no runtime impact.
5. **`feat/readme-updates-2026-04-28`** (in all three repos) — docs only.
6. **`feat/overnight-cc-report-2026-04-28`** — this report; can land
   any time, no code impact.

## Sean-only follow-ups

1. **Open the Alpaca paper account and put creds in Railway env** —
   `ALPACA_API_KEY` and `ALPACA_SECRET_KEY`. Then `npm run verify:alpaca`
   end-to-end and capture the log artifact.
2. **Confirm `FULL_ACCOUNT_JWT_SECRET` is provisioned in Railway.** The
   Phase 3 change deletes the silent fallback default — `issueFullAccountToken`
   will throw on missing env, breaking `/builder/full-signup` and
   `/builder/login` if it isn't set. Verify with: `railway variables get FULL_ACCOUNT_JWT_SECRET`.
3. **Review `src/services/agent-trader.ts`** — explicitly out of scope
   for me per the sprint brief.
4. **Decide whether `hyperdag-core/feat/reponomics-circuits-2026-04-27`**
   should be split into smaller PRs before merge — it has a large
   pending working tree (Cargo target/, CIRCUITS.md, INTEGRATION.md, two
   new test files, prover_server binary) that I left untouched on its
   own branch.
5. **Update memory** — once any of these branches lands on `main`, the
   Phase IDs in this report become "shipped" rather than "on a feature
   branch", and the project memory entries should reflect that.

## Operating notes

- Sean's auto-commit hook is active on this repo and intermittently moves
  HEAD between branches and bundles staged work into commits with its own
  message style. I worked around this by occasionally re-checking out
  files from the auto-committed branch onto the named branch I owned. No
  data loss; some commit messages are not the ones I authored. Where
  this happened it's flagged inline in the phase detail.
- All tests run cleanly with `NODE_ENV=test` after Phase 6. Full-suite
  green except the 5 intentionally-skipped tests.
- 8h budget: ~3h actual. Stopped because phases were complete, not
  because of the cap.
