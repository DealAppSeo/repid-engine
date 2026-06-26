# deploy/ — portable-standby PREP artifacts (XC, 2026-06-26)

PREP ONLY. Railway stays PRIMARY. The Fly standby stays IDLE until CC's egress poll fix is merged.
All Fly/DNS/secret/game-day steps are **[SEAN]**-gated. No self-merge.

| File | Purpose |
|---|---|
| `../Dockerfile` | One portable multi-stage build (Railway/Fly/Coolify). Handles the git-pinned private dep via a BuildKit secret. |
| `../.dockerignore` | Keeps secrets/scratch/built-output out of the image + lean context. |
| `../fly.toml` | Fly warm standby `repid-engine-standby` in `sjc`, `/health` check, `min_machines_running=1`. |
| `TOPOLOGY.md` | Phase 0 — the "75 → 2–3" reconcile (worktrees vs deploy targets) + prune dispositions. |
| `ENV_MANIFEST.md` | Env-var KEY surface (names only, secret/non-secret) to provision the standby. |
| `fly.secrets.template` | Placeholder names for `flyctl secrets import` — NEVER commit a filled copy. |
| `FAILOVER_TARGET.md` | The `active_engine_url` flip seam (resolution order; CC/GA wire consumers). |
| `FAILOVER_RUNBOOK.md` | DETECT→DECIDE→ACT→RECOVER + game-day kill-test, RTO ≤10 min. **ACTIVATION GATE: blocked pre-CC-fix.** |
| `RAILWAY_MCP_PORT.md` | Deploy-control port railway-mcp → flyctl/Coolify + single GH Actions pipeline. |
| `../.github/workflows/deploy.yml` | merge→deploy to active target (default `railway`; Fly opt-in). |

PARKED (deferred, do not execute): Coolify+Hetzner consolidation spec at
`E:\dev\living-docs\03_specs\COOLIFY_HETZNER_CONSOLIDATION_PARKED.md`.

## DEPENDENCY
**CC's egress poll fix MUST be deployed before the standby is ACTIVATED** (production engineUrl flip).
Activating earlier just relocates the burning Supabase egress bill to Fly — "fix the fire before moving
house." The standby may be built / deployed IDLE / game-day tested in an isolated window beforehand.
