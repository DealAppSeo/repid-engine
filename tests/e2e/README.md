# E2E tests — live Railway flow

These tests hit the **deployed** repid-engine, not a local app. They are
intentionally excluded from `npm test` and only run via `npm run test:e2e`.

## Why

Unit tests mock Supabase, the auth middleware, the rate limiter, etc. A
clean unit suite is necessary but not sufficient — deployment-environment
bugs (auth misconfig, schema drift, missing Railway env vars, CORS
breakage, RPC failures) only show up here.

## Run

```bash
# Default: hit production Railway, no API key.
npm run test:e2e

# Override target (staging / local).
E2E_BASE_URL=http://localhost:3000 npm run test:e2e

# With an API key for endpoints still gated by REPID_API_KEYS auth.
E2E_API_KEY=<key> npm run test:e2e

# Post-rollout: treat any unverified step as a failure. This is the mode to
# run once the deployment is expected to have caught up — i.e. most of the time.
E2E_STRICT=1 npm run test:e2e
```

## Behavior

The flow walks the no-wallet visitor path:

1. `GET  /api/v1/health` — service reachable
2. `POST /api/v1/builder/token-signup` — token + `0xdead0e707…` address
3. `POST /api/v1/stake/deposit` — authority bump
4. `POST /api/v1/demo/run-round-anonymous` — APM/VERITAS deltas
5. `GET  /api/v1/demo/two-builder/snapshot` — Builder W and M authority
6. `GET  /api/v1/metrics` — public counters

Each step is its own `it()`. If a public auth bypass is missing on the
deployed build (the endpoint returns 401 for an unauthenticated POST),
the step **soft-skips** rather than failing the suite. This is
intentional — during the rollout window between merging the live-demo
branch and Railway redeploying, the deployment lags the code, and we want
the diagnostic to be readable, not a wall of red.

### A skip is not a pass

Returning early from an `it()` marks it **passed**. So every soft-skip
above used to render as a green tick, and the more broken the deployment,
the more steps skipped — the greener the suite got. Measured against stub
deployments:

| Deployment under test | Reported (before) | Reported (now) |
|---|---|---|
| Working | 6 passed ✅ | 7 passed ✅ |
| Every route `404` | 3 of 6 passed | 4 failed |
| Every route `401` | 4 of 6 passed | 3 failed |
| Public GETs live, business endpoints `401` | **6 of 6 passed, exit 0** | 1 failed |
| Host unreachable | 1 passed | 6 failed |

The fourth row is the one that mattered: a fully green run against a
service that never issued a token, never took a deposit, never ran a round
and reported zero authority. (The single green tick in the unreachable
case was the deposit step — it passed *because* the step before it failed
to produce an address.)

The tolerance stays; what changed is that skips are now **recorded and
surfaced**, and two things enforce honesty:

- **The ledger.** Every step records `VERIFIED` / `NOT CHECKED` / `FAILED`
  with a reason, printed as a table at the end of the run.
- **The guard.** A final `it()` fails the suite if *no* core flow step
  (signup, deposit, round) was verified. Reachability, a public snapshot
  and a metrics counter can all be served by a deployment where the actual
  product is broken — that must not read as green.

`E2E_STRICT=1` turns every tolerated skip into a failure. Once the
deployment has caught up, that is the correct mode; the default tolerance
exists only for the rollout window.

## What the script does NOT do

- Does not write to a real DB outside the demo seed scope.
- Does not require Sean-signature approvals — those routes stay protected
  on the deployed build and are not exercised here.
- Does not validate ZKP proofs; that lives in the unit suite.
- Does not assert specific RepID values (the live DB drifts) — only
  shapes (number, present, > 0 when builder is above floor).

## When to run

- After every merge to a branch that gets auto-deployed by Railway.
- Before announcing a demo run to make sure the public flow is intact.
- Manually when investigating a "works locally, broken in prod" report.
