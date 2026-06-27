# RAILWAY_MCP_PORT — deploy-control port: railway-mcp → flyctl / Coolify (Phase 5)
PREP doc · 2026-06-26 · XC lane · DESIGN only (no deploy verbs executed)

## WHY
Deploy control must **survive a Railway API outage**. Today, deploy/restart/logs flow through
`railway-mcp` (Railway GraphQL wrapper). If Railway's control plane is down, an operator can't even
restart or roll back. Porting the deploy verbs to `flyctl` (and, parked, Coolify REST) keeps deploy
control alive on a second provider. The **same portable Dockerfile** (Phase 1) is the build substrate
for every target, so a deploy is the same artifact everywhere.

## VERB MAP (1:1 — operator can deploy/restart/inspect WITHOUT the Railway dashboard)
| Intent | railway-mcp / Railway | flyctl (standby, ACTIVE port) | Coolify REST (PARKED — names only) |
|---|---|---|---|
| Deploy latest | `railway up` / MCP deploy | `flyctl deploy --remote-only -a repid-engine-standby` (with `--build-secret gh_token=…`) | `POST /api/v1/deploy` (app uuid) |
| Status | MCP status / `railway status` | `flyctl status -a repid-engine-standby` | `GET /api/v1/applications/{uuid}` |
| Restart | MCP restart | `flyctl apps restart repid-engine-standby` (or `flyctl machine restart <id>`) | `POST /api/v1/applications/{uuid}/restart` |
| Logs | MCP logs / `railway logs` | `flyctl logs -a repid-engine-standby` | `GET /api/v1/applications/{uuid}/logs` |
| Scale / warm | Railway replicas | `flyctl scale count 1 -a repid-engine-standby` | `PATCH /api/v1/applications/{uuid}` |
| Secrets (names) | `railway variables --json \| jq keys` | `flyctl secrets list` | `GET /api/v1/applications/{uuid}/envs` |
| Set secret | Railway dashboard / `railway variables set` [SEAN] | `flyctl secrets set NAME=… -a repid-engine-standby` [SEAN] | `POST …/envs` [SEAN] |

> Coolify column is **PARKED** (Phase 7 consolidation, deferred). Listed so the verb map is complete and
> the future port is a fill-in, not a redesign.

## SINGLE GitHub Actions PIPELINE (merge → deploy to the ACTIVE target)
File: `.github/workflows/deploy.yml` (added this sprint). Behavior:
- Triggers **only on `push` to `main`** (i.e. AFTER a PR is merged by Sean) — it **never** opens or
  merges a PR (no self-merge).
- Builds the **same Dockerfile** for whichever target `DEPLOY_TARGET` selects.
- `DEPLOY_TARGET` (workflow input / repo variable) ∈ `{railway, fly}`, **default `railway`** → Sean's
  current flow is preserved; the Fly path is opt-in.
- Fly path uses `superfly/flyctl-actions/setup-flyctl` + `flyctl deploy --remote-only` with the
  `FLY_API_TOKEN` GitHub secret **[SEAN]** and the `gh_token` build secret for the private dep.
- Railway path: documented as Sean's existing flow (Railway auto-deploys from main); the workflow's
  railway branch is a no-op placeholder so the single pipeline file covers both without duplicating CI.

## [SEAN] PREREQUISITES (collected, not executed here)
1. Add `FLY_API_TOKEN` to GitHub Actions secrets (for the Fly deploy path).
2. Add `GH_DEP_TOKEN` (PAT with `repo` scope) to GitHub Actions secrets — passed as the Docker
   `--build-secret gh_token` so the build resolves the private `@hyperdag/proof-verifier` dep.
3. Decide whether to flip `DEPLOY_TARGET` to `fly` for any deploy (default stays `railway`).

## SAFETY
- Default `DEPLOY_TARGET=railway` ⇒ adding this workflow changes nothing about today's deploys.
- Never auto-merges; runs post-merge on `main` only.
- Build secrets are mounted, never baked into a layer or committed.
