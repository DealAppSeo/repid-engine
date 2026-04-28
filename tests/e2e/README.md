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
the step **soft-skips with a `console.warn`** rather than failing the
suite. This is intentional — during the rollout window between merging
the live-demo branch and Railway redeploying, the deployment lags the
code, and we want the diagnostic to be readable, not a wall of red.

Once the deployment catches up (visible by step 2 returning 200 with a
token), all six steps must pass for the suite to be green.

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
